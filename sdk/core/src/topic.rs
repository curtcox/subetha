//! Topic grammar (spec §1.2).
//!
//! - Namespaced: `@` handle `/` name, handle = `[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?`,
//!   name = `[A-Za-z0-9_-]{1,64}`.
//! - Secret: `t_` + 26 chars of `[a-z2-7]` (128 random bits, lowercase base32).

use crate::encoding::base32_encode;
use crate::random::fill_random;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedTopic<'a> {
    Namespaced { handle: &'a str, name: &'a str },
    Secret,
}

/// Is `s` a valid handle (`[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?`)?
pub fn is_handle(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= 39
        && alnum(&b[0])
        && alnum(&b[b.len() - 1])
        && b.iter().all(|c| alnum(c) || *c == b'-')
}

fn is_name(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn is_secret(s: &str) -> bool {
    s.len() == 28
        && s.starts_with("t_")
        && s.as_bytes()[2..].iter().all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(c))
}

/// Parses a topic name, or returns `None` if it doesn't match the grammar.
pub fn parse_topic(topic: &str) -> Option<ParsedTopic<'_>> {
    if is_secret(topic) {
        return Some(ParsedTopic::Secret);
    }
    let rest = topic.strip_prefix('@')?;
    let (handle, name) = rest.split_once('/')?;
    (is_handle(handle) && is_name(name)).then_some(ParsedTopic::Namespaced { handle, name })
}

pub fn is_topic(topic: &str) -> bool {
    parse_topic(topic).is_some()
}

/// A fresh unguessable secret topic (128 random bits).
pub fn secret_topic() -> String {
    let mut b = [0u8; 16];
    fill_random(&mut b);
    format!("t_{}", base32_encode(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar() {
        assert_eq!(
            parse_topic("@alice/door-bell_1"),
            Some(ParsedTopic::Namespaced { handle: "alice", name: "door-bell_1" })
        );
        assert_eq!(parse_topic("t_mfrggzdfmztwq2lknnwg23tpoa"), Some(ParsedTopic::Secret));
        for bad in ["@a-/x", "@/x", "@a/", "@a/b/c", "@A/x", "t_abc", "@a/é", "alice/x"] {
            assert!(!is_topic(bad), "{bad}");
        }
        assert!(is_topic(&format!("@{}/x", "a".repeat(39))));
        assert!(!is_topic(&format!("@{}/x", "a".repeat(40))));
    }

    #[test]
    fn secret_topics_are_valid_and_distinct() {
        let a = secret_topic();
        let b = secret_topic();
        assert!(is_topic(&a) && is_topic(&b));
        assert_ne!(a, b);
    }
}
