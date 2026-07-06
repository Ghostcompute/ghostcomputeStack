// Governance program (P9) — Realms-style on-chain privacy policy.
// Holds the privacy parameters the protocol enforces: max attestation age,
// supported enclave vendors, and which guarantee tiers require attestation.
// Mirrors supabase governance_params; the authority is a Realms DAO key.

use anchor_lang::prelude::*;

declare_id!("4NgovqpUuSFYkRNQNupy9koZUKd8DNo5i4L2i4dXkj7f");

// Bitflags for supported enclaves.
pub const ENCLAVE_NVIDIA_CC:  u8 = 1 << 0;
pub const ENCLAVE_AMD_SEV:    u8 = 1 << 1;

// Bitflags for guarantee tiers that require attestation.
pub const TIER_STANDARD:        u8 = 1 << 0;
pub const TIER_HIGH:            u8 = 1 << 1;
pub const TIER_MAX_TRUST_SPLIT: u8 = 1 << 2;

#[program]
pub mod governance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: PolicyParams) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.authority                 = ctx.accounts.authority.key();
        policy.attestation_max_age_secs  = params.attestation_max_age_secs;
        policy.supported_enclaves        = params.supported_enclaves;
        policy.require_attestation_tiers  = params.require_attestation_tiers;
        policy.verify_pass_rate_min_bps  = params.verify_pass_rate_min_bps;
        policy.bump                      = ctx.bumps.policy;
        emit!(PolicyUpdated { authority: policy.authority });
        Ok(())
    }

    /// Update policy. Only the governance authority (Realms DAO) may call.
    pub fn update_policy(ctx: Context<UpdatePolicy>, params: PolicyParams) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require_keys_eq!(policy.authority, ctx.accounts.authority.key(), GovError::Unauthorized);
        policy.attestation_max_age_secs = params.attestation_max_age_secs;
        policy.supported_enclaves       = params.supported_enclaves;
        policy.require_attestation_tiers = params.require_attestation_tiers;
        policy.verify_pass_rate_min_bps = params.verify_pass_rate_min_bps;
        emit!(PolicyUpdated { authority: policy.authority });
        Ok(())
    }

    /// Hand governance to a new authority (e.g. DAO upgrade).
    pub fn transfer_authority(ctx: Context<UpdatePolicy>, new_authority: Pubkey) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require_keys_eq!(policy.authority, ctx.accounts.authority.key(), GovError::Unauthorized);
        policy.authority = new_authority;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyParams {
    pub attestation_max_age_secs: i64,
    pub supported_enclaves:       u8, // bitflags
    pub require_attestation_tiers: u8, // bitflags
    pub verify_pass_rate_min_bps: u16,
}

#[account]
pub struct PrivacyPolicy {
    pub authority:                 Pubkey,
    pub attestation_max_age_secs:  i64,
    pub supported_enclaves:        u8,
    pub require_attestation_tiers: u8,
    pub verify_pass_rate_min_bps:  u16,
    pub bump:                      u8,
}

#[event]
pub struct PolicyUpdated { pub authority: Pubkey }

#[error_code]
pub enum GovError {
    #[msg("Caller is not the governance authority")]
    Unauthorized,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 8 + 1 + 1 + 2 + 1,
        seeds = [b"privacy_policy"],
        bump,
    )]
    pub policy:    Account<'info, PrivacyPolicy>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(mut, seeds = [b"privacy_policy"], bump = policy.bump)]
    pub policy:    Account<'info, PrivacyPolicy>,
    pub authority: Signer<'info>,
}
