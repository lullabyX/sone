//! Queue-mirror bookkeeping. SONE's queue atoms are the desired state; this
//! tracks the tail entries SONE enqueued after the current track. The watcher
//! consumes from the front as the speaker self-advances (native gapless);
//! `sonos_sync_queue_tail` diffs desired vs mirrored and applies the
//! cheapest correct operation.

use std::collections::VecDeque;

/// One SONE-enqueued queue entry after the current track. `qid` is the
/// frontend's queue-instance id (dup-safe — the same track can appear twice).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorEntry {
    pub track_id: u64,
    pub qid: String,
}

#[derive(Debug, Default)]
pub struct MirrorState {
    /// Tail entries after the currently-playing track, in play order.
    pub entries: VecDeque<MirrorEntry>,
    /// True once the speaker queue holds SONE's current track (play_track ran,
    /// or reattach verified it). Until then tail syncs must not touch the
    /// speaker's leftover queue.
    pub seeded: bool,
}

/// What `sonos_sync_queue_tail` must do to make the speaker match `desired`.
#[derive(Debug, PartialEq, Eq)]
pub enum SyncPlan {
    /// Already in sync.
    NoOp,
    /// `desired` extends the mirrored tail: append `desired[skip..]`.
    Append { skip: usize },
    /// Anything else: wipe the tail after the current track and re-add all.
    Rewrite,
}

pub fn plan_sync(mirrored: &VecDeque<MirrorEntry>, desired: &[MirrorEntry]) -> SyncPlan {
    if mirrored.len() > desired.len() {
        return SyncPlan::Rewrite;
    }
    let prefix_matches = mirrored
        .iter()
        .zip(desired.iter())
        .all(|(have, want)| have == want);
    if !prefix_matches {
        return SyncPlan::Rewrite;
    }
    if mirrored.len() == desired.len() {
        SyncPlan::NoOp
    } else {
        SyncPlan::Append {
            skip: mirrored.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(track_id: u64, qid: &str) -> MirrorEntry {
        MirrorEntry {
            track_id,
            qid: qid.to_string(),
        }
    }

    #[test]
    fn equal_tails_are_a_noop() {
        let mirrored: VecDeque<_> = vec![e(1, "a"), e(2, "b")].into();
        assert_eq!(
            plan_sync(&mirrored, &[e(1, "a"), e(2, "b")]),
            SyncPlan::NoOp
        );
        assert_eq!(plan_sync(&VecDeque::new(), &[]), SyncPlan::NoOp);
    }

    #[test]
    fn extension_appends_only_the_suffix() {
        let mirrored: VecDeque<_> = vec![e(1, "a")].into();
        assert_eq!(
            plan_sync(&mirrored, &[e(1, "a"), e(2, "b"), e(3, "c")]),
            SyncPlan::Append { skip: 1 }
        );
        assert_eq!(
            plan_sync(&VecDeque::new(), &[e(1, "a")]),
            SyncPlan::Append { skip: 0 }
        );
    }

    #[test]
    fn reorder_shrink_or_replace_rewrites() {
        let mirrored: VecDeque<_> = vec![e(1, "a"), e(2, "b")].into();
        // Reorder
        assert_eq!(
            plan_sync(&mirrored, &[e(2, "b"), e(1, "a")]),
            SyncPlan::Rewrite
        );
        // Shrink (queue edit removed an entry)
        assert_eq!(plan_sync(&mirrored, &[e(1, "a")]), SyncPlan::Rewrite);
        // Same track, different instance
        assert_eq!(
            plan_sync(&mirrored, &[e(1, "a"), e(2, "OTHER")]),
            SyncPlan::Rewrite
        );
        // Cleared
        assert_eq!(plan_sync(&mirrored, &[]), SyncPlan::Rewrite);
    }
}
