use super::models::ConnectDevice;
use log::{debug, info};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub const TIDAL_CONNECT_SERVICE: &str = "_tidalconnect._tcp.local.";

#[derive(Clone)]
pub struct DiscoveryEngine {
    daemon: Option<ServiceDaemon>,
    devices: Arc<RwLock<HashMap<String, ConnectDevice>>>,
    is_scanning: Arc<RwLock<bool>>,
}

impl DiscoveryEngine {
    pub fn new() -> Self {
        Self {
            daemon: None,
            devices: Arc::new(RwLock::new(HashMap::new())),
            is_scanning: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn start(&mut self) -> Result<(), String> {
        let mut scanning = self.is_scanning.write().await;
        if *scanning {
            return Ok(());
        }

        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let receiver = daemon
            .browse(TIDAL_CONNECT_SERVICE)
            .map_err(|e| e.to_string())?;

        self.daemon = Some(daemon);
        *scanning = true;

        let devices = Arc::clone(&self.devices);
        let is_scanning = Arc::clone(&self.is_scanning);

        tokio::spawn(async move {
            info!("TIDAL Connect mDNS scanner started for {}", TIDAL_CONNECT_SERVICE);
            while let Ok(event) = receiver.recv_async().await {
                if !*is_scanning.read().await {
                    break;
                }

                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let full_name = info.get_fullname().to_string();
                        let host = info.get_hostname().to_string();
                        let port = info.get_port();
                        let addresses: Vec<String> = info
                            .get_addresses()
                            .iter()
                            .map(|ip| ip.to_string())
                            .collect();

                        let mut txt_records = HashMap::new();
                        for property in info.get_properties().iter() {
                            txt_records.insert(
                                property.key().to_string(),
                                property.val_str().to_string(),
                            );
                        }

                        let friendly_name = txt_records
                            .get("fn")
                            .or_else(|| txt_records.get("friendlyName"))
                            .cloned()
                            .unwrap_or_else(|| {
                                full_name
                                    .trim_end_matches(TIDAL_CONNECT_SERVICE)
                                    .trim_end_matches('.')
                                    .to_string()
                            });

                        let model_name = txt_records
                            .get("mn")
                            .or_else(|| txt_records.get("md"))
                            .or_else(|| txt_records.get("modelName"))
                            .cloned()
                            .unwrap_or_else(|| "TIDAL Connect Speaker".to_string());

                        let device = ConnectDevice {
                            id: full_name.clone(),
                            name: friendly_name,
                            model_name,
                            host,
                            port,
                            addresses,
                            txt_records,
                            is_local: false,
                        };

                        debug!("Discovered TIDAL Connect device: {} at port {}", device.name, device.port);
                        devices.write().await.insert(full_name, device);
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        debug!("TIDAL Connect device removed: {}", fullname);
                        devices.write().await.remove(&fullname);
                    }
                    _ => {}
                }
            }
            debug!("TIDAL Connect mDNS scanner stopped");
        });

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        let mut scanning = self.is_scanning.write().await;
        if !*scanning {
            return Ok(());
        }

        *scanning = false;
        if let Some(daemon) = self.daemon.take() {
            let _ = daemon.stop_browse(TIDAL_CONNECT_SERVICE);
        }

        Ok(())
    }

    pub async fn get_devices(&self) -> Vec<ConnectDevice> {
        self.devices.read().await.values().cloned().collect()
    }
}
