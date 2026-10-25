use eyre::{eyre, OptionExt};
use parking_lot::RwLock;
use reqwest::{Request, Response, StatusCode, Url};
use reqwest_middleware::ClientWithMiddleware;

#[derive(Default)]
pub(super) struct ApiRouting {
    state: RwLock<RouteState>,
}

#[derive(Default)]
struct RouteState {
    configured_domains: Vec<String>,
    preferred_domain: Option<String>,
}

impl RouteState {
    fn candidates(&mut self, configured_domains: &[String]) -> Vec<String> {
        if self.configured_domains != configured_domains {
            self.configured_domains = configured_domains.to_vec();
            self.preferred_domain = None;
        }
        let mut domains = configured_domains.to_vec();
        if let Some(index) = domains
            .iter()
            .position(|domain| Some(domain) == self.preferred_domain.as_ref())
        {
            domains.rotate_left(index);
        }
        domains
    }
}

impl ApiRouting {
    pub(super) fn reset(&self) {
        *self.state.write() = RouteState::default();
    }

    pub(super) async fn send(
        &self,
        client: &ClientWithMiddleware,
        request: Request,
        configured_domains: &[String],
        can_replay: bool,
    ) -> eyre::Result<Response> {
        let domains = self.state.write().candidates(configured_domains);
        let mut failures = Vec::new();
        let mut last_error = None;

        for domain in &domains {
            let mut attempt = request.try_clone().ok_or_eyre("无法重放 API 请求体")?;
            let mut url = Url::parse(&format!("{}://{domain}", request.url().scheme()))?;
            url.set_path(request.url().path());
            url.set_query(request.url().query());
            *attempt.url_mut() = url;

            let error = match client.execute(attempt).await {
                Ok(response)
                    if can_replay
                        && (response.status().is_server_error()
                            || response.status() == StatusCode::NOT_FOUND) =>
                {
                    eyre!("HTTP {}", response.status())
                }
                Ok(response) => {
                    if response.status().is_success() {
                        let mut state = self.state.write();
                        // 旧请求的结果不能覆盖用户后来选择的线路。
                        if state.configured_domains == configured_domains {
                            state.preferred_domain = Some(domain.clone());
                        }
                        if !failures.is_empty() {
                            tracing::warn!(api_domain = %domain, attempts = failures.len() + 1, "API 请求已切换至可用线路");
                        }
                    }
                    return Ok(response);
                }
                Err(error) => {
                    // 写请求只有在连接失败、尚未发送时才能安全重试。
                    let retryable = error.is_connect()
                        || (can_replay
                            && (error.is_timeout() || error.is_request() || error.is_body()));
                    let error = eyre::Report::from(error.without_url());
                    if !retryable {
                        return Err(error);
                    }
                    error
                }
            };
            tracing::warn!(api_domain = %domain, error = ?error, "API 线路请求失败");
            failures.push(format!("{domain}: {error:#}"));
            last_error = Some(error);
        }

        Err(last_error.ok_or_eyre("未配置 API 线路")?.wrap_err(format!(
            "所有 API 线路请求失败，请检查网络或代理：\n{}",
            failures.join("\n")
        )))
    }
}

#[cfg(test)]
mod tests;
