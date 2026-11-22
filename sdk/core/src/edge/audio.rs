//! Data-over-sound modem: 16-FSK at 48 kHz (ggwave-style), pure DSP with no audio I/O.
//!
//! Frame layout (one symbol = 10 ms = 480 samples, one nibble per data symbol):
//!
//! ```text
//! preamble   8 symbols alternating 1500 Hz / 5600 Hz (marker tones, outside the data band)
//! sync       2 bytes 0x2D 0xD4
//! length     u16 big-endian (payload bytes, <= MAX_PAYLOAD)
//! payload    length bytes
//! crc        CRC-16/CCITT-FALSE over length || payload, big-endian
//! ```
//!
//! Data tones are `2000 + 200·k` Hz for nibble `k` (2.0–5.0 kHz). Every tone is a multiple of
//! 100 Hz, so each completes a whole number of cycles per symbol: tones are orthogonal over a
//! symbol window and the waveform is phase-continuous without extra bookkeeping. The
//! demodulator finds the preamble with a sliding Goertzel correlator, refines the timing,
//! then picks the strongest tone in each symbol window. Throughput is 50 bytes/s, which suits
//! ids, wake-ups and short messages.

use crate::crc::crc16_ccitt;

pub const SAMPLE_RATE: u32 = 48_000;
/// Samples per symbol (10 ms).
pub const SYMBOL_SAMPLES: usize = 480;
/// Largest payload a frame can carry.
pub const MAX_PAYLOAD: usize = 1024;
/// Peak amplitude of the generated signal.
pub const AMPLITUDE: f32 = 0.5;

const PREAMBLE_TONES: [f32; 2] = [1500.0, 5600.0];
const PREAMBLE_SYMBOLS: usize = 8;
const SYNC: [u8; 2] = [0x2D, 0xD4];
const DATA_BASE_HZ: f32 = 2000.0;
const DATA_STEP_HZ: f32 = 200.0;
/// Coarse timing search step.
const SEARCH_STEP: usize = SYMBOL_SAMPLES / 8;
const FADE_SAMPLES: usize = 48;
const CANDIDATES: usize = 6;

fn data_tone(nibble: u8) -> f32 {
    DATA_BASE_HZ + DATA_STEP_HZ * f32::from(nibble)
}

fn preamble_tone(i: usize) -> f32 {
    PREAMBLE_TONES[i % 2]
}

/// Number of PCM samples a payload of `len` bytes modulates to.
pub fn frame_samples(len: usize) -> usize {
    (PREAMBLE_SYMBOLS + 2 * (SYNC.len() + 2 + len + 2)) * SYMBOL_SAMPLES
}

/// The tone (Hz) of every symbol in the frame for `payload`, preamble first.
///
/// # Panics
/// If `payload` is longer than [`MAX_PAYLOAD`].
pub fn tones(payload: &[u8]) -> Vec<f32> {
    assert!(payload.len() <= MAX_PAYLOAD, "audio payload too large");
    let len = payload.len() as u16;
    let mut body = Vec::with_capacity(payload.len() + 6);
    body.extend_from_slice(&len.to_be_bytes());
    body.extend_from_slice(payload);
    let crc = crc16_ccitt(&body);
    let mut bytes = SYNC.to_vec();
    bytes.extend_from_slice(&body);
    bytes.extend_from_slice(&crc.to_be_bytes());

    let mut tones: Vec<f32> = (0..PREAMBLE_SYMBOLS).map(preamble_tone).collect();
    for b in bytes {
        tones.push(data_tone(b >> 4));
        tones.push(data_tone(b & 15));
    }
    tones
}

/// Modulates `payload` into mono f32 PCM at [`SAMPLE_RATE`].
///
/// # Panics
/// If `payload` is longer than [`MAX_PAYLOAD`].
pub fn modulate(payload: &[u8]) -> Vec<f32> {
    let tones = tones(payload);
    let mut out = Vec::with_capacity(tones.len() * SYMBOL_SAMPLES);
    let w = 2.0 * std::f32::consts::PI / SAMPLE_RATE as f32;
    for f in tones {
        // Whole cycles per symbol: restarting the phase at 0 is continuous.
        out.extend((0..SYMBOL_SAMPLES).map(|n| AMPLITUDE * (w * f * n as f32).sin()));
    }
    let total = out.len();
    for i in 0..FADE_SAMPLES.min(total / 2) {
        let g = 0.5 - 0.5 * (std::f32::consts::PI * i as f32 / FADE_SAMPLES as f32).cos();
        out[i] *= g;
        out[total - 1 - i] *= g;
    }
    out
}

/// Goertzel power of `freq` over one symbol window starting at `start`.
fn power(samples: &[f32], start: usize, freq: f32) -> f32 {
    let coeff = 2.0 * (2.0 * std::f32::consts::PI * freq / SAMPLE_RATE as f32).cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for &x in &samples[start..start + SYMBOL_SAMPLES] {
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/// Preamble match score for a frame starting at `start`.
fn preamble_score(samples: &[f32], start: usize) -> f32 {
    (0..PREAMBLE_SYMBOLS)
        .map(|i| {
            let at = start + i * SYMBOL_SAMPLES;
            power(samples, at, preamble_tone(i)) - power(samples, at, preamble_tone(i + 1))
        })
        .sum()
}

fn demod_symbol(samples: &[f32], start: usize) -> u8 {
    let mut best = (0u8, f32::MIN);
    for k in 0..16u8 {
        let p = power(samples, start, data_tone(k));
        if p > best.1 {
            best = (k, p);
        }
    }
    best.0
}

/// Reads `count` bytes starting at symbol index `sym` after the preamble at `start`.
fn read_bytes(samples: &[f32], start: usize, sym: usize, count: usize) -> Option<Vec<u8>> {
    let end = start + (PREAMBLE_SYMBOLS + sym + 2 * count) * SYMBOL_SAMPLES;
    if end > samples.len() {
        return None;
    }
    Some(
        (0..count)
            .map(|i| {
                let at = |j: usize| start + (PREAMBLE_SYMBOLS + sym + 2 * i + j) * SYMBOL_SAMPLES;
                (demod_symbol(samples, at(0)) << 4) | demod_symbol(samples, at(1))
            })
            .collect(),
    )
}

fn decode_at(samples: &[f32], start: usize) -> Option<Vec<u8>> {
    let head = read_bytes(samples, start, 0, 4)?;
    if head[..2] != SYNC {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([head[2], head[3]]));
    if len > MAX_PAYLOAD {
        return None;
    }
    let rest = read_bytes(samples, start, 8, len + 2)?;
    let (payload, crc) = rest.split_at(len);
    let mut body = head[2..4].to_vec();
    body.extend_from_slice(payload);
    (crc16_ccitt(&body).to_be_bytes() == crc).then(|| payload.to_vec())
}

/// Finds and decodes the first valid frame in `samples`. `None` if no frame with a valid
/// sync word and CRC is present.
pub fn demodulate(samples: &[f32]) -> Option<Vec<u8>> {
    let min = frame_samples(0);
    if samples.len() < min {
        return None;
    }
    // Coarse search over offsets where at least an empty frame fits.
    let last = samples.len() - min;
    let mut scored: Vec<(usize, f32)> =
        (0..=last).step_by(SEARCH_STEP).map(|o| (o, preamble_score(samples, o))).filter(|(_, s)| *s > 0.0).collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut tried: Vec<usize> = Vec::new();
    for (coarse, _) in scored {
        if tried.len() >= CANDIDATES {
            break;
        }
        if tried.iter().any(|&t| t.abs_diff(coarse) < SYMBOL_SAMPLES) {
            continue;
        }
        tried.push(coarse);
        // Fine timing: best score within one search step either side.
        let lo = coarse.saturating_sub(SEARCH_STEP);
        let hi = (coarse + SEARCH_STEP).min(last);
        let mut best = (coarse, f32::MIN);
        for o in (lo..=hi).step_by(4) {
            let s = preamble_score(samples, o);
            if s > best.1 {
                best = (o, s);
            }
        }
        if let Some(p) = decode_at(samples, best.0) {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::random::SplitMix64;

    /// Standard normal samples via Box–Muller.
    fn gaussian(rng: &mut SplitMix64) -> f32 {
        let u1 = rng.next_f64().max(1e-12);
        let u2 = rng.next_f64();
        ((-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()) as f32
    }

    fn embed(signal: &[f32], lead: usize, tail: usize, sigma: f32, seed: u64) -> Vec<f32> {
        let mut rng = SplitMix64::new(seed);
        let mut out = vec![0.0; lead];
        out.extend_from_slice(signal);
        out.extend(std::iter::repeat_n(0.0, tail));
        for x in &mut out {
            *x += sigma * gaussian(&mut rng);
        }
        out
    }

    #[test]
    fn clean_roundtrip() {
        for payload in [&b""[..], b"x", b"01JD5A2Z3K8Q9V6X7W4T1R0S2M", &[0u8, 255, 16, 15, 0xA5, 0x5A]] {
            let pcm = modulate(payload);
            assert_eq!(pcm.len(), frame_samples(payload.len()));
            assert!(pcm.iter().all(|x| x.abs() <= AMPLITUDE));
            assert_eq!(demodulate(&pcm).as_deref(), Some(payload));
        }
    }

    #[test]
    fn roundtrip_with_white_noise_and_offset() {
        let payload = b"subetha: front door opened @ 01JD5A2Z3K8Q9V6X7W4T1R0S2M".to_vec();
        let pcm = modulate(&payload);
        // sigma 0.35 vs. amplitude 0.5: per-sample SNR = 0.125 / 0.1225 ~ 0.1 dB.
        for (seed, lead) in [(1u64, 1234usize), (2, 7), (3, 4801), (4, 333)] {
            let noisy = embed(&pcm, lead, 2000, 0.35, seed);
            assert_eq!(demodulate(&noisy), Some(payload.clone()), "seed {seed}");
        }
    }

    #[test]
    fn rejects_noise_and_truncation() {
        let noise = embed(&[], 48_000, 0, 0.3, 9);
        assert_eq!(demodulate(&noise), None);
        assert_eq!(demodulate(&[]), None);
        let pcm = modulate(b"hello");
        assert_eq!(demodulate(&pcm[..pcm.len() - SYMBOL_SAMPLES]), None);
    }

    #[test]
    fn corrupted_symbol_fails_crc() {
        let mut pcm = modulate(b"hello world");
        // Overwrite one payload symbol with a different data tone.
        let sym = PREAMBLE_SYMBOLS + 2 * 4 + 3;
        let w = 2.0 * std::f32::consts::PI / SAMPLE_RATE as f32;
        let at = sym * SYMBOL_SAMPLES;
        let orig = demod_symbol(&pcm, at);
        let f = data_tone((orig + 5) % 16);
        for n in 0..SYMBOL_SAMPLES {
            pcm[at + n] = AMPLITUDE * (w * f * n as f32).sin();
        }
        assert_eq!(demodulate(&pcm), None);
    }

    #[test]
    fn finds_second_frame_after_garbage() {
        let mut pcm = modulate(b"first");
        let cut = pcm.len() / 2;
        pcm.truncate(cut); // a broken first frame
        pcm.extend(modulate(b"second"));
        assert_eq!(demodulate(&pcm).as_deref(), Some(&b"second"[..]));
    }
}
