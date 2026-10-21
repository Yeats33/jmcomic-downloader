use bytes::Bytes;
use eyre::{eyre, WrapErr};

use crate::jm_client::JmClient;

const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

pub(super) async fn stream_image(
    client: &JmClient,
    url: &str,
    mut on_chunk: impl FnMut(Bytes) -> eyre::Result<()>,
) -> eyre::Result<String> {
    for attempt in 0..2 {
        let mut request = client.image_request(url);
        if attempt != 0 {
            request = request.query(&[("ts", uuid::Uuid::new_v4().to_string())]);
        }
        let response = request.send().await?.error_for_status()?;
        match stream_response(response, &mut on_chunk).await? {
            Some(mime) => return Ok(mime),
            None => continue,
        }
    }
    Err(eyre!("服务器返回空图片，请重试"))
}

async fn stream_response(
    mut response: reqwest::Response,
    on_chunk: &mut impl FnMut(Bytes) -> eyre::Result<()>,
) -> eyre::Result<Option<String>> {
    let mut prefix = Vec::new();
    let mut received = 0;
    while let Some(chunk) = response.chunk().await.wrap_err("接收在线图片失败")? {
        received += chunk.len();
        if received > MAX_IMAGE_BYTES {
            return Err(eyre!("在线图片超过64 MiB，无法在内存中阅读"));
        }
        let take = chunk.len().min(32 - prefix.len());
        prefix.extend_from_slice(&chunk[..take]);
        on_chunk(chunk)?;
    }
    if received == 0 {
        return Ok(None);
    }
    let format = image::guess_format(&prefix).wrap_err("在线图片格式无效")?;
    Ok(Some(format.to_mime_type().to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn forwards_the_first_chunk_before_the_response_finishes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let count = socket.read(&mut request).await.unwrap();
                assert!(count > 0 && header.len() < 8192);
                header.extend_from_slice(&request[..count]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n\x89PNG\r\n\x1a\n\r\n").await.unwrap();
            release_rx.await.unwrap();
            socket.write_all(b"4\r\ntail\r\n0\r\n\r\n").await.unwrap();
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let mut release = Some(release);
        let mut received = Vec::new();

        let mime = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream_response(response, &mut |chunk| {
                received.extend_from_slice(&chunk);
                if let Some(sender) = release.take() {
                    sender.send(()).unwrap();
                }
                Ok(())
            }),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(mime.as_deref(), Some("image/png"));
        assert_eq!(&received, b"\x89PNG\r\n\x1a\ntail");
        server.await.unwrap();
    }
}
