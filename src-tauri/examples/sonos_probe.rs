//! Hardware validation harness for the Sonos protocol layer.
//!
//! Read-only sweep (safe to run any time):
//!   cargo run --example sonos_probe
//!   cargo run --example sonos_probe -- --ip 192.168.1.23
//!
//! Full playback probe — AUDIBLE: clears the group's queue and plays the
//! given TIDAL track on the coordinator, exercising enqueue → play → seek →
//! pause → volume → (optionally a second track + Next):
//!   cargo run --example sonos_probe -- --track 157273957 [--room "Living Room"] [--next-track 3216922]
//!   cargo run --example sonos_probe -- --track 157273957 --uri-style http
//!
//! `--uri-style` picks the EnqueuedURI form: `bare` (SoCo sharelink, default)
//! or `http` (noson-style x-sonos-http with sid/flags/sn).

use std::time::Duration;

use tauri_app_lib::sonos::{accounts, avtransport, didl, discovery, rendering, soap, topology};

struct Args {
    ip: Option<String>,
    room: Option<String>,
    track: Option<u64>,
    next_track: Option<u64>,
    /// Non-audible enqueue test: append one TIDAL item to the END of the
    /// queue (no transport change, nothing plays), then remove exactly that
    /// entry. Validates the URI/DIDL format + household TIDAL linkage.
    dry_add: Option<u64>,
    uri_style: String,
}

fn parse_args() -> Args {
    let mut args = Args {
        ip: None,
        room: None,
        track: None,
        next_track: None,
        dry_add: None,
        uri_style: "bare".to_string(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .unwrap_or_else(|| panic!("missing value for {flag}"))
        };
        match flag.as_str() {
            "--ip" => args.ip = Some(value()),
            "--room" => args.room = Some(value()),
            "--track" => args.track = Some(value().parse().expect("--track must be a TIDAL id")),
            "--next-track" => {
                args.next_track = Some(value().parse().expect("--next-track must be a TIDAL id"))
            }
            "--dry-add" => {
                args.dry_add = Some(value().parse().expect("--dry-add must be a TIDAL id"))
            }
            "--uri-style" => args.uri_style = value(),
            other => panic!("unknown flag: {other}"),
        }
    }
    args
}

fn pick_group<'a>(
    groups: &'a [topology::ZoneGroup],
    room: &Option<String>,
) -> &'a topology::ZoneGroup {
    match room {
        Some(room) => groups
            .iter()
            .find(|g| g.name.eq_ignore_ascii_case(room))
            .unwrap_or_else(|| panic!("no group named {room:?}")),
        None => groups.first().expect("no groups in household"),
    }
}

fn pick_style(uri_style: &str, tidal_serial: &Option<String>) -> didl::TrackUriStyle {
    match uri_style {
        "bare" => didl::TrackUriStyle::Bare,
        "http" => didl::TrackUriStyle::SonosHttp {
            // Serial is unreadable on modern firmware; "1" is the first
            // account slot and the overwhelmingly common single-account case.
            account_serial: tidal_serial.clone().unwrap_or_else(|| "1".to_string()),
        },
        other => panic!("unknown --uri-style {other} (use bare|http)"),
    }
}

fn probe_meta(track_id: u64) -> didl::TrackMeta {
    didl::TrackMeta {
        title: format!("SONE probe track {track_id}"),
        artist: "SONE".to_string(),
        album: "sonos_probe".to_string(),
    }
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let client = soap::lan_client();

    // 1. Discovery
    let ips = match &args.ip {
        Some(ip) => vec![ip.clone()],
        None => {
            println!("SSDP M-SEARCH (3s)...");
            let mut found = discovery::ssdp_search(Duration::from_secs(3))
                .await
                .expect("SSDP search failed");
            println!("  responders: {found:?}");
            if found.is_empty() {
                println!("Subnet sweep (port 1400)...");
                found = discovery::subnet_sweep().await;
                println!("  responders: {found:?}");
            }
            if found.is_empty() {
                eprintln!("No Sonos players found. Try --ip <player-ip>.");
                std::process::exit(1);
            }
            found
        }
    };

    // Non-Sonos devices can answer a port sweep; take the first that serves
    // a real device description.
    let mut entry: Option<discovery::SonosDevice> = None;
    for ip in &ips {
        match discovery::probe_ip(&client, ip).await {
            Ok(device) => {
                entry = Some(device);
                break;
            }
            Err(e) => println!("  skipping {ip}: {e}"),
        }
    }
    let device = entry.expect("no responder served a Sonos device description");
    let entry_ip = &device.ip.clone();
    println!(
        "Entry player: {} ({}, {}) at {}",
        device.room_name, device.model_name, device.uuid, device.ip
    );

    // 2. Topology
    let groups = topology::get_zone_groups(&client, entry_ip)
        .await
        .expect("GetZoneGroupState failed");
    println!("Zone groups:");
    for g in &groups {
        let members: Vec<&str> = g.members.iter().map(|m| m.name.as_str()).collect();
        println!(
            "  [{}] coordinator {} at {} — members: {}",
            g.name,
            g.coordinator_uuid,
            g.coordinator_ip,
            members.join(", ")
        );
    }

    // 3. Accounts
    let tidal = accounts::get_tidal_account(&client, entry_ip)
        .await
        .expect("/status/accounts failed");
    let tidal_serial = match &tidal {
        accounts::TidalLinkStatus::Linked(acct) => {
            println!("TIDAL account: linked (serial {})", acct.serial);
            Some(acct.serial.clone())
        }
        accounts::TidalLinkStatus::NotLinked => {
            println!("TIDAL account: NOT linked");
            None
        }
        accounts::TidalLinkStatus::Unknown => {
            println!("TIDAL account: unknown (modern firmware hides the account list)");
            None
        }
    };

    // 3b. Non-audible enqueue validation
    if let Some(dry_id) = args.dry_add {
        let group = pick_group(&groups, &args.room);
        let ip = &group.coordinator_ip;
        let style = pick_style(&args.uri_style, &tidal_serial);
        let uri = didl::track_enqueue_uri(dry_id, &style);
        let meta = probe_meta(dry_id);
        let didl_xml = didl::track_didl(dry_id, &meta);
        println!("\n=== Dry-add on [{}] ({ip}) — no playback ===", group.name);
        println!("EnqueuedURI: {uri}");
        match avtransport::add_uri_to_queue(&client, ip, &uri, &didl_xml, 0, false).await {
            Ok(added) => {
                println!(
                    "  accepted: position={} qlen={} — removing it again...",
                    added.first_track_nr, added.queue_length
                );
                avtransport::remove_track_from_queue(&client, ip, added.first_track_nr)
                    .await
                    .expect("RemoveTrackFromQueue failed — remove the probe entry manually");
                println!("  removed. Enqueue format + TIDAL link: OK");
            }
            Err(e) => println!("  REJECTED: {e}"),
        }
    }

    let Some(track_id) = args.track else {
        println!("\nSweep done. --dry-add <id> tests enqueue silently; --track <id> runs the audible probe.");
        return;
    };

    // 4. Playback probe (audible!)
    let group = pick_group(&groups, &args.room);
    let ip = &group.coordinator_ip;
    println!("\n=== Audible probe on [{}] ({ip}) ===", group.name);

    let style = pick_style(&args.uri_style, &tidal_serial);
    let meta = probe_meta(track_id);
    let uri = didl::track_enqueue_uri(track_id, &style);
    let didl_xml = didl::track_didl(track_id, &meta);
    println!("EnqueuedURI: {uri}");

    println!("RemoveAllTracksFromQueue...");
    avtransport::remove_all_tracks_from_queue(&client, ip)
        .await
        .expect("clear queue failed");

    println!("AddURIToQueue...");
    let added = avtransport::add_uri_to_queue(&client, ip, &uri, &didl_xml, 0, false)
        .await
        .expect("AddURIToQueue failed — try the other --uri-style");
    println!(
        "  first={} added={} qlen={}",
        added.first_track_nr, added.num_added, added.queue_length
    );

    println!("SetAVTransportURI(x-rincon-queue) + SetPlayMode(NORMAL) + Play...");
    avtransport::set_av_transport_uri(&client, ip, &didl::queue_uri(&group.coordinator_uuid), "")
        .await
        .expect("SetAVTransportURI failed");
    avtransport::set_play_mode(&client, ip, "NORMAL")
        .await
        .expect("SetPlayMode failed");
    avtransport::play(&client, ip).await.expect("Play failed");

    for i in 0..6 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let state = avtransport::get_transport_state(&client, ip)
            .await
            .expect("GetTransportInfo");
        let pos = avtransport::get_position_info(&client, ip)
            .await
            .expect("GetPositionInfo");
        println!(
            "  t+{}s: state={state:?} track={} pos={:?}/{:?} uri={}",
            (i + 1) * 2,
            pos.track_nr,
            pos.position_secs,
            pos.duration_secs,
            pos.track_uri
        );
        if let Some(parsed) = didl::parse_track_uri(&pos.track_uri) {
            assert_eq!(parsed, track_id, "TrackURI should round-trip our track id");
        }
    }

    println!("Seek to 0:01:00...");
    avtransport::seek_rel_time(&client, ip, 60.0)
        .await
        .expect("Seek failed");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let pos = avtransport::get_position_info(&client, ip)
        .await
        .expect("GetPositionInfo");
    println!("  after seek: pos={:?}", pos.position_secs);

    let vol = rendering::get_group_volume(&client, ip)
        .await
        .expect("GetGroupVolume");
    println!(
        "Group volume: {vol} — nudging to {} and back...",
        vol.saturating_sub(5)
    );
    rendering::set_group_volume(&client, ip, vol.saturating_sub(5))
        .await
        .expect("SetGroupVolume");
    tokio::time::sleep(Duration::from_secs(1)).await;
    rendering::set_group_volume(&client, ip, vol)
        .await
        .expect("SetGroupVolume restore");

    if let Some(next_id) = args.next_track {
        println!("Enqueue second track {next_id} as next + Next()...");
        let next_uri = didl::track_enqueue_uri(next_id, &style);
        let next_didl = didl::track_didl(next_id, &probe_meta(next_id));
        avtransport::add_uri_to_queue(&client, ip, &next_uri, &next_didl, 0, true)
            .await
            .expect("AddURIToQueue (next) failed");
        avtransport::next(&client, ip).await.expect("Next failed");
        tokio::time::sleep(Duration::from_secs(3)).await;
        let pos = avtransport::get_position_info(&client, ip)
            .await
            .expect("GetPositionInfo");
        println!("  now on track {} uri={}", pos.track_nr, pos.track_uri);
    }

    println!("Pause + clear queue (cleanup)...");
    avtransport::pause(&client, ip).await.expect("Pause failed");
    avtransport::remove_all_tracks_from_queue(&client, ip)
        .await
        .expect("cleanup failed");
    println!("Probe complete.");
}
