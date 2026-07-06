// Attestation program: verifies TEE reports and issues on-chain attestation NFTs/stamps
// owned for the verification logic; the worker provides the skeleton

use anchor_lang::prelude::*;

declare_id!("6t3oGF7eUHHj1ZiRZcr68i9AXgdt1GothfdLbffJLzKr");

#[program]
pub mod attestation {
    use super::*;

    /// Submit a TEE attestation report for a worker.
    /// Verification logic (owned) is called via CPI or oracle.
    pub fn submit_attestation(
        ctx: Context<SubmitAttestation>,
        tee_type: u8,
        report_hash: [u8; 32],
        timestamp: i64,
    ) -> Result<()> {
        let record = &mut ctx.accounts.attestation_record;
        record.worker   = ctx.accounts.worker.key();
        record.tee_type = tee_type;
        record.report_hash = report_hash;
        record.verified  = false; // set true by oracle after off-chain verification
        record.timestamp = timestamp;
        record.bump      = ctx.bumps.attestation_record;
        Ok(())
    }

    /// Oracle marks attestation as verified after checking the TEE cert chain.
    pub fn verify_attestation(ctx: Context<VerifyAttestation>) -> Result<()> {
        let record = &mut ctx.accounts.attestation_record;
        require!(!record.verified, AttestError::AlreadyVerified);
        record.verified = true;
        record.verified_at = Clock::get()?.unix_timestamp;
        emit!(AttestationVerified { worker: record.worker, tee_type: record.tee_type });
        Ok(())
    }
}

#[error_code]
pub enum AttestError {
    #[msg("Already verified")]
    AlreadyVerified,
}

#[event]
pub struct AttestationVerified { pub worker: Pubkey, pub tee_type: u8 }

#[account]
pub struct AttestationRecord {
    pub worker:      Pubkey,
    pub tee_type:    u8,
    pub report_hash: [u8; 32],
    pub verified:    bool,
    pub timestamp:   i64,
    pub verified_at: i64,
    pub bump:        u8,
}

#[derive(Accounts)]
pub struct SubmitAttestation<'info> {
    #[account(
        init,
        payer = worker,
        space = 8 + 32 + 1 + 32 + 1 + 8 + 8 + 1,
        seeds = [b"attestation", worker.key().as_ref()],
        bump,
    )]
    pub attestation_record: Account<'info, AttestationRecord>,
    #[account(mut)]
    pub worker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyAttestation<'info> {
    #[account(
        mut,
        seeds = [b"attestation", attestation_record.worker.as_ref()],
        bump = attestation_record.bump,
    )]
    pub attestation_record: Account<'info, AttestationRecord>,
    pub oracle: Signer<'info>,
}
