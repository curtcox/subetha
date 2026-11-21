//! Randomness: the OS CSPRNG for keys, nonces and ids, plus a tiny deterministic PRNG
//! (SplitMix64) used where reproducibility matters (fountain-code degree sampling, tests).

/// Fills `buf` from the operating system's CSPRNG.
///
/// # Panics
/// If the OS provides no randomness source, which is unrecoverable for a crypto SDK.
pub fn fill_random(buf: &mut [u8]) {
    getrandom::getrandom(buf).expect("OS random number generator unavailable");
}

/// Returns `N` random bytes from the OS CSPRNG.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    fill_random(&mut b);
    b
}

/// SplitMix64: small, fast, deterministic, *not* cryptographic.
#[derive(Debug, Clone)]
pub struct SplitMix64(u64);

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in `[0, n)`; `n` must be > 0.
    pub fn below(&mut self, n: u64) -> u64 {
        // Multiply-shift; bias is negligible for the small ranges used here.
        ((u128::from(self.next_u64()) * u128::from(n)) >> 64) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_reference_values() {
        // Reference outputs for seed 0 from the SplitMix64 paper's C implementation.
        let mut r = SplitMix64::new(0);
        assert_eq!(r.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(r.next_u64(), 0x6E78_9E6A_A1B9_65F4);
        let mut r = SplitMix64::new(7);
        for _ in 0..1000 {
            assert!(r.below(10) < 10);
            let f = r.next_f64();
            assert!((0.0..1.0).contains(&f));
        }
    }

    #[test]
    fn os_random_differs() {
        assert_ne!(random_bytes::<16>(), random_bytes::<16>());
    }
}
