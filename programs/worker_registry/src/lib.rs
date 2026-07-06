use anchor_lang::prelude::*;

declare_id!("FqFRLgewksUxwrtni1oXNAmcw2ZJ4oAWZWPHJgU9ACgo");

#[program]
pub mod worker_registry {
    use super::*;

    pub fn register_worker(ctx: Context<RegisterWorker>, params: RegisterWorkerParams) -> Result<()> {
        let worker = &mut ctx.accounts.worker;
        worker.pubkey       = ctx.accounts.authority.key();
        worker.model_hash   = params.model_hash;
        worker.tok_per_sec  = params.tok_per_sec;
        worker.tee_type     = params.tee_type;
        worker.vram_gb      = params.vram_gb;
        worker.reputation   = 10_000; // 1.0 in basis points
        worker.registered_at = Clock::get()?.unix_timestamp;
        worker.bump         = ctx.bumps.worker;
        // Attestation fields start fail-closed: not confidential until verified.
        worker.confidential_ok  = false;
        worker.verify_pass_rate = 10_000;
        worker.attest_uptime    = 0;
        worker.last_attest      = 0;
        Ok(())
    }

    pub fn update_reputation(ctx: Context<UpdateReputation>, delta: i16) -> Result<()> {
        let worker = &mut ctx.accounts.worker;
        worker.reputation = (worker.reputation as i32 + delta as i32).clamp(0, 10_000) as u16;
        Ok(())
    }

    /// Oracle updates the worker's attestation fields after the off-chain
    /// Attestation Verifier (P3) reaches a verdict. `confidential_ok`
    /// gates confidential routing; `last_attest` drives fail-closed staleness.
    pub fn update_attestation(
        ctx: Context<UpdateAttestation>,
        confidential_ok: bool,
        verify_pass_rate: u16, // basis points
        attest_uptime: u16,    // basis points
        last_attest: i64,      // unix seconds
    ) -> Result<()> {
        let worker = &mut ctx.accounts.worker;
        worker.confidential_ok  = confidential_ok;
        worker.verify_pass_rate = verify_pass_rate.min(10_000);
        worker.attest_uptime    = attest_uptime.min(10_000);
        worker.last_attest      = last_attest;
        emit!(AttestationUpdated {
            worker: worker.pubkey,
            confidential_ok,
            last_attest,
        });
        Ok(())
    }

    /// Fail-closed (P8): an oracle can drop a worker from confidential routing
    /// when its attestation goes stale or verification fails.
    pub fn drop_confidential(ctx: Context<UpdateAttestation>) -> Result<()> {
        let worker = &mut ctx.accounts.worker;
        worker.confidential_ok = false;
        emit!(AttestationUpdated {
            worker: worker.pubkey,
            confidential_ok: false,
            last_attest: worker.last_attest,
        });
        Ok(())
    }

    pub fn deregister_worker(ctx: Context<DeregisterWorker>) -> Result<()> {
        // account closed via close = authority constraint
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterWorkerParams {
    pub model_hash:  [u8; 32],
    pub tok_per_sec: u32,
    pub tee_type:    u8,   // 0=none, 1=nvidia_cc, 2=amd_sev_snp
    pub vram_gb:     u16,
}

#[account]
pub struct WorkerAccount {
    pub pubkey:        Pubkey,
    pub model_hash:    [u8; 32],
    pub tok_per_sec:   u32,
    pub tee_type:      u8,
    pub vram_gb:       u16,
    pub reputation:    u16,   // basis points, 10000 = 1.0
    pub registered_at: i64,
    pub bump:          u8,
    // P9 attestation fields:
    pub confidential_ok:  bool, // eligible for confidential (High/MaxTrustSplit) routing
    pub verify_pass_rate: u16,  // basis points
    pub attest_uptime:    u16,  // basis points
    pub last_attest:      i64,  // unix seconds of last verified attestation
}

#[event]
pub struct AttestationUpdated {
    pub worker:          Pubkey,
    pub confidential_ok: bool,
    pub last_attest:     i64,
}

#[derive(Accounts)]
pub struct UpdateAttestation<'info> {
    #[account(mut, seeds = [b"worker", worker.pubkey.as_ref()], bump = worker.bump)]
    pub worker: Account<'info, WorkerAccount>,
    pub oracle: Signer<'info>, // trusted attestation oracle key
}

#[derive(Accounts)]
pub struct RegisterWorker<'info> {
    #[account(
        init,
        payer = authority,
        // discriminator + base fields + attest fields (bool 1 + u16 2 + u16 2 + i64 8)
        space = 8 + 32 + 32 + 4 + 1 + 2 + 2 + 8 + 1 + 1 + 2 + 2 + 8,
        seeds = [b"worker", authority.key().as_ref()],
        bump,
    )]
    pub worker:    Account<'info, WorkerAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateReputation<'info> {
    #[account(mut, seeds = [b"worker", worker.pubkey.as_ref()], bump = worker.bump)]
    pub worker:  Account<'info, WorkerAccount>,
    pub oracle:  Signer<'info>,  // trusted oracle key
}

#[derive(Accounts)]
pub struct DeregisterWorker<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"worker", authority.key().as_ref()],
        bump = worker.bump,
    )]
    pub worker:    Account<'info, WorkerAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
