//! ULID message ids (spec §1.1). Monotonic within a millisecond, like the TS reference.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::random::fill_random;
use crate::Error;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A monotonic ULID generator. Pure apart from the randomness source passed to [`next`].
///
/// [`next`]: UlidGenerator::next
#[derive(Debug, Default, Clone)]
pub struct UlidGenerator {
    last_time: Option<u64>,
    last_random: [u8; 16],
}

impl UlidGenerator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Generates a ULID for `now_ms`. Within the same millisecond the random part is
    /// incremented so ids stay strictly increasing.
    pub fn next(&mut self, now_ms: u64, random: impl FnOnce(&mut [u8; 16])) -> String {
        let rand = if self.last_time == Some(now_ms) {
            let mut r = self.last_random;
            for d in r.iter_mut().rev() {
                if *d < 31 {
                    *d += 1;
                    break;
                }
                *d = 0;
            }
            r
        } else {
            let mut r = [0u8; 16];
            random(&mut r);
            r.iter_mut().for_each(|d| *d &= 31);
            r
        };
        self.last_time = Some(now_ms);
        self.last_random = rand;
        let mut out = [0u8; 26];
        let mut n = now_ms;
        for i in (0..10).rev() {
            out[i] = CROCKFORD[(n % 32) as usize];
            n /= 32;
        }
        for (i, d) in rand.iter().enumerate() {
            out[10 + i] = CROCKFORD[*d as usize];
        }
        String::from_utf8(out.to_vec()).expect("ascii")
    }
}

static GLOBAL: Mutex<UlidGenerator> = Mutex::new(UlidGenerator { last_time: None, last_random: [0; 16] });

/// Current Unix time in milliseconds.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Current Unix time in seconds.
pub fn now_secs() -> u64 {
    now_ms() / 1000
}

/// A fresh ULID for the current time.
pub fn ulid() -> String {
    ulid_at(now_ms())
}

/// A fresh ULID for the given time (ms).
pub fn ulid_at(now_ms: u64) -> String {
    let mut g = GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
    g.next(now_ms, |r| fill_random(r))
}

fn crockford_value(c: u8) -> Option<u64> {
    let c = c.to_ascii_uppercase();
    CROCKFORD.iter().position(|&x| x == c).map(|p| p as u64)
}

/// Is `s` a ULID (26 Crockford base32 chars, case-insensitive)?
pub fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|c| crockford_value(c).is_some())
}

/// The millisecond timestamp encoded in a ULID's first 10 characters.
pub fn ulid_time(id: &str) -> Result<u64, Error> {
    if id.len() < 10 {
        return Err(Error::InvalidUlid);
    }
    id.bytes()
        .take(10)
        .try_fold(0u64, |n, c| crockford_value(c).map(|v| n * 32 + v))
        .ok_or(Error::InvalidUlid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_roundtrip_and_shape() {
        let t = 1_763_750_000_123;
        let id = ulid_at(t);
        assert!(is_ulid(&id), "{id}");
        assert_eq!(ulid_time(&id).unwrap(), t);
        assert_eq!(ulid_time(&id.to_lowercase()).unwrap(), t);
        assert_eq!(ulid_time("01JD5A2Z3K8Q9V6X7W4T1R0S2M").unwrap(), 1_732_123_917_427);
        assert!(ulid_time("01JD5A2Z3U").is_err());
        assert!(!is_ulid("01JD5A2Z3K8Q9V6X7W4T1R0S2I"));
    }

    #[test]
    fn monotonic_within_millisecond() {
        let mut g = UlidGenerator::new();
        let a = g.next(5, |r| {
            *r = [0; 16];
            r[15] = 31;
        });
        let b = g.next(5, |_| unreachable!());
        let c = g.next(5, |_| unreachable!());
        assert!(a < b && b < c, "{a} {b} {c}");
        assert_eq!(&b[10..], "0000000000000010");
        let d = g.next(6, |r| *r = [0; 16]);
        assert!(c < d);
        assert_eq!(&d[10..], "0000000000000000");
    }

    #[test]
    fn global_ids_increase() {
        let ids: Vec<String> = (0..50).map(|_| ulid()).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
    }
}
