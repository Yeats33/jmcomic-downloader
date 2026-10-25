use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use reqwest::StatusCode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket};
use tokio::task::JoinSet;

use super::*;

struct Server {
    domain: String,
    requests: Arc<RwLock<Vec<String>>>,
    _tasks: JoinSet<()>,
}

impl Server {
    async fn start(status: StatusCode) -> Self {
        Self::respond(Some(status)).await
    }

    async fn respond(status: Option<StatusCode>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let domain = listener.local_addr().unwrap().to_string();
        let requests = Arc::new(RwLock::new(Vec::new()));
        let captured = requests.clone();
        let mut tasks = JoinSet::new();
        tasks.spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let length = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(length, 0);
                    bytes.extend_from_slice(&buffer[..length]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + content_length {
                            break;
                        }
                    }
                }
                captured.write().push(String::from_utf8(bytes).unwrap());
                match status {
                    Some(status) => {
                        let response = format!(
                            "HTTP/1.1 {}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                            status
                        );
                        socket.write_all(response.as_bytes()).await.unwrap();
                    }
                    None => {
                        // 保持连接，直到客户端的请求超时并关闭连接。
                        assert_eq!(socket.read(&mut buffer).await.unwrap(), 0);
                    }
                }
            }
        });
        Self {
            domain,
            requests,
            _tasks: tasks,
        }
    }
}

fn request(client: &ClientWithMiddleware, domain: &str) -> Request {
    client
        .get(format!("http://{domain}/search"))
        .build()
        .unwrap()
}

fn refused_connection() -> TcpSocket {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    socket
}

fn client() -> ClientWithMiddleware {
    reqwest_middleware::ClientBuilder::new(
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap(),
    )
    .build()
}

#[tokio::test]
async fn search_moves_to_next_route_when_selected_route_is_unavailable() {
    let unavailable = Server::start(StatusCode::BAD_GATEWAY).await;
    let healthy = Server::start(StatusCode::OK).await;
    let domains = [unavailable.domain.clone(), healthy.domain.clone()];
    let client = client();
    let request = client
        .get(format!("http://{}/search", unavailable.domain))
        .query(&[("search_query", "囚禁"), ("page", "1"), ("o", "tf")])
        .header("token", "test-token")
        .header("tokenparam", "123,2.0.13")
        .build()
        .unwrap();

    let response = ApiRouting::default()
        .send(&client, request, &domains, true)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "ok");
    assert_eq!(unavailable.requests.read().len(), 1);
    let requests = healthy.requests.read();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].starts_with("GET /search?search_query=%E5%9B%9A%E7%A6%81&page=1&o=tf HTTP/1.1")
    );
    assert!(requests[0].contains("token: test-token\r\n"));
    assert!(requests[0].contains("tokenparam: 123,2.0.13\r\n"));
}

#[tokio::test]
async fn next_request_reuses_successful_route_without_probing_failed_route() {
    let unavailable = Server::start(StatusCode::SERVICE_UNAVAILABLE).await;
    let healthy = Server::start(StatusCode::OK).await;
    let domains = [unavailable.domain.clone(), healthy.domain.clone()];
    let client = client();
    let routing = ApiRouting::default();
    routing
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();

    let response = routing
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(unavailable.requests.read().len(), 1);
    assert_eq!(healthy.requests.read().len(), 2);
}

#[tokio::test]
async fn changed_selection_takes_priority_over_remembered_route() {
    let first = Server::start(StatusCode::OK).await;
    let second = Server::start(StatusCode::OK).await;
    let client = client();
    let routing = ApiRouting::default();
    let domains = [first.domain.clone(), second.domain.clone()];
    routing
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();
    let changed = [second.domain.clone(), first.domain.clone()];

    routing
        .send(&client, request(&client, &changed[0]), &changed, true)
        .await
        .unwrap();

    assert_eq!(first.requests.read().len(), 1);
    assert_eq!(second.requests.read().len(), 1);
}

#[tokio::test]
async fn proxy_reload_clears_remembered_route() {
    let unavailable = Server::start(StatusCode::BAD_GATEWAY).await;
    let healthy = Server::start(StatusCode::OK).await;
    let domains = [unavailable.domain.clone(), healthy.domain.clone()];
    let client = client();
    let routing = ApiRouting::default();
    routing
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();

    routing.reset();
    routing
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();

    assert_eq!(unavailable.requests.read().len(), 2);
    assert_eq!(healthy.requests.read().len(), 2);
}

#[tokio::test]
async fn missing_api_endpoint_tries_the_next_route() {
    let missing = Server::start(StatusCode::NOT_FOUND).await;
    let healthy = Server::start(StatusCode::OK).await;
    let domains = [missing.domain.clone(), healthy.domain.clone()];
    let client = client();

    let response = ApiRouting::default()
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(healthy.requests.read().len(), 1);
}

#[tokio::test]
async fn business_and_authentication_errors_do_not_switch_routes() {
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::TOO_MANY_REQUESTS,
    ] {
        let rejected = Server::start(status).await;
        let unused = Server::start(StatusCode::OK).await;
        let domains = [rejected.domain.clone(), unused.domain.clone()];
        let client = client();

        let response = ApiRouting::default()
            .send(&client, request(&client, &domains[0]), &domains, true)
            .await
            .unwrap();

        assert_eq!(response.status(), status);
        assert_eq!(rejected.requests.read().len(), 1);
        assert!(unused.requests.read().is_empty());
    }
}

#[tokio::test]
async fn every_failed_route_is_attempted_once_and_reported() {
    let first = Server::start(StatusCode::BAD_GATEWAY).await;
    let second = Server::start(StatusCode::SERVICE_UNAVAILABLE).await;
    let domains = [first.domain.clone(), second.domain.clone()];
    let client = client();

    let error = ApiRouting::default()
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap_err();

    let message = format!("{error:#}");
    for domain in &domains {
        assert!(message.contains(domain));
    }
    assert_eq!(first.requests.read().len(), 1);
    assert_eq!(second.requests.read().len(), 1);
}

#[tokio::test]
async fn post_body_is_preserved_when_connection_fails_before_send() {
    let refused = refused_connection();
    let healthy = Server::start(StatusCode::OK).await;
    let domains = [
        refused.local_addr().unwrap().to_string(),
        healthy.domain.clone(),
    ];
    let client = client();
    let request = client
        .post(format!("http://{}/favorite", domains[0]))
        .form(&[("aid", "12345")])
        .build()
        .unwrap();

    let response = ApiRouting::default()
        .send(&client, request, &domains, false)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let requests = healthy.requests.read();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /favorite HTTP/1.1\r\n"));
    assert!(requests[0].ends_with("\r\n\r\naid=12345"));
}

#[tokio::test]
async fn post_is_not_replayed_when_server_may_have_applied_the_change() {
    let failed = Server::start(StatusCode::INTERNAL_SERVER_ERROR).await;
    let unused = Server::start(StatusCode::OK).await;
    let domains = [failed.domain.clone(), unused.domain.clone()];
    let client = client();
    let request = client
        .post(format!("http://{}/favorite", domains[0]))
        .form(&[("aid", "12345")])
        .build()
        .unwrap();

    let response = ApiRouting::default()
        .send(&client, request, &domains, false)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failed.requests.read().len(), 1);
    assert!(unused.requests.read().is_empty());
}

#[tokio::test]
async fn read_request_switches_routes_after_response_timeout() {
    let stalled = Server::respond(None).await;
    let healthy = Server::start(StatusCode::OK).await;
    let domains = [stalled.domain.clone(), healthy.domain.clone()];
    let client = client();

    let response = ApiRouting::default()
        .send(&client, request(&client, &domains[0]), &domains, true)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(stalled.requests.read().len(), 1);
    assert_eq!(healthy.requests.read().len(), 1);
}

#[tokio::test]
async fn post_is_not_replayed_after_response_timeout() {
    let stalled = Server::respond(None).await;
    let unused = Server::start(StatusCode::OK).await;
    let domains = [stalled.domain.clone(), unused.domain.clone()];
    let client = client();
    let request = client
        .post(format!("http://{}/favorite", domains[0]))
        .form(&[("aid", "12345")])
        .build()
        .unwrap();

    let error = ApiRouting::default()
        .send(&client, request, &domains, false)
        .await
        .unwrap_err();

    assert!(error
        .downcast_ref::<reqwest_middleware::Error>()
        .unwrap()
        .is_timeout());
    assert_eq!(stalled.requests.read().len(), 1);
    assert!(unused.requests.read().is_empty());
}
