use anchor_lang::prelude::*;

declare_id!("EfDmESepZJJfsUUCHX7KC4F5Rbnf7Bdt4mQX76DAT5nB");

#[program]
pub mod job_router {
    use super::*;

    pub fn submit_job(ctx: Context<SubmitJob>, params: SubmitJobParams) -> Result<()> {
        let job = &mut ctx.accounts.job;
        job.id          = params.id;
        job.owner       = ctx.accounts.owner.key();
        job.guarantee   = params.guarantee;
        job.status      = 1; // running (routed off-chain immediately)
        job.x402_amount = params.x402_amount;
        job.created_at  = Clock::get()?.unix_timestamp;
        job.bump        = ctx.bumps.job;
        Ok(())
    }

    pub fn complete_job(ctx: Context<CompleteJob>, toploc: [u8; 32]) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == 1, JobError::NotRunning);
        job.status      = 2; // completed
        job.toploc      = toploc;
        job.completed_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status < 2, JobError::AlreadyDone);
        job.status = 3; // cancelled
        Ok(())
    }
}

#[error_code]
pub enum JobError {
    #[msg("Job is not in running state")]
    NotRunning,
    #[msg("Job is already completed or cancelled")]
    AlreadyDone,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SubmitJobParams {
    pub id:          [u8; 16],  // UUID bytes
    pub guarantee:   u8,        // 0=standard, 1=high, 2=max_trust_split
    pub x402_amount: u64,       // GHST lamports pre-authorized
}

#[account]
pub struct JobAccount {
    pub id:           [u8; 16],
    pub owner:        Pubkey,
    pub guarantee:    u8,
    pub status:       u8,
    pub x402_amount:  u64,
    pub toploc:       [u8; 32],
    pub created_at:   i64,
    pub completed_at: i64,
    pub bump:         u8,
}

#[derive(Accounts)]
#[instruction(params: SubmitJobParams)]
pub struct SubmitJob<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 16 + 32 + 1 + 1 + 8 + 32 + 8 + 8 + 1,
        seeds = [b"job", params.id.as_ref()],
        bump,
    )]
    pub job:    Account<'info, JobAccount>,
    #[account(mut)]
    pub owner:  Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompleteJob<'info> {
    #[account(mut, seeds = [b"job", job.id.as_ref()], bump = job.bump)]
    pub job:    Account<'info, JobAccount>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    #[account(mut, seeds = [b"job", job.id.as_ref()], bump = job.bump)]
    pub job:   Account<'info, JobAccount>,
    pub owner: Signer<'info>,
}
