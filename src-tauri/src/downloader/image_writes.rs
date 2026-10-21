use std::sync::Arc;

use eyre::WrapErr;
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

const WRITE_CAPACITY: u16 = u16::MAX;

/// Permit由Rayon闭包持有，取消等待图片的future不会提前释放它。
#[derive(Clone)]
pub struct ImageWrites(Arc<Semaphore>);

impl ImageWrites {
    pub fn new() -> Self {
        Self(Arc::new(Semaphore::new(usize::from(WRITE_CAPACITY))))
    }

    pub fn is_idle(&self) -> bool {
        self.0.available_permits() == usize::from(WRITE_CAPACITY)
    }

    pub async fn run(
        &self,
        job: impl FnOnce() -> eyre::Result<()> + Send + 'static,
    ) -> eyre::Result<()> {
        let permit = self.0.clone().acquire_owned().await?;
        let (sender, receiver) = oneshot::channel();
        rayon::spawn(move || {
            let result = job();
            drop(permit);
            // 接收方可能已经取消，但实际写入必须先结束。
            if sender.send(result).is_err() {
                tracing::trace!("图片等待已取消，后台写入已结束");
            }
        });
        receiver.await.wrap_err("等待图片写入失败")?
    }

    pub async fn drain(&self) -> eyre::Result<OwnedSemaphorePermit> {
        self.0
            .clone()
            .acquire_many_owned(u32::from(WRITE_CAPACITY))
            .await
            .wrap_err("等待后台图片写入结束失败")
    }
}

#[cfg(test)]
mod tests {
    use super::ImageWrites;
    use std::time::Duration;

    #[tokio::test]
    async fn cancelled_waiter_does_not_finish_a_running_rayon_write() {
        let writes = ImageWrites::new();
        let worker_writes = writes.clone();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let output =
            std::env::temp_dir().join(format!("jmcomic-writer-test-{}", uuid::Uuid::new_v4()));
        let worker_output = output.clone();
        let worker = tokio::spawn(async move {
            worker_writes
                .run(move || {
                    started.send(()).unwrap();
                    release_rx.recv()?;
                    std::fs::write(worker_output, "completed write")?;
                    Ok(())
                })
                .await
        });
        started_rx.await.unwrap();

        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), writes.drain())
                .await
                .is_err()
        );
        assert!(!output.exists());
        release.send(()).unwrap();

        let drained = tokio::time::timeout(Duration::from_secs(5), writes.drain())
            .await
            .unwrap()
            .unwrap();
        drop(drained);
        assert!(writes.is_idle());
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "completed write");
        std::fs::remove_file(output).unwrap();
    }

    #[tokio::test]
    async fn write_error_releases_the_writer_permit() {
        let writes = ImageWrites::new();

        let result = writes.run(|| Err(eyre::eyre!("write failed"))).await;

        assert!(result.is_err());
        assert!(writes.is_idle());
    }
}
