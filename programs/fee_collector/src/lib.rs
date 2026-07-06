use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

declare_id!("AfLg5yqWBayDubpFPn8VAks2WmFmceJTQLWx7oHXnwq");

// FeeCollector: receives 10bps from every GHST transfer (via TransferHook)
// Distributes: 60% stakers / 20% workers / 10% burn / 10% treasury

const STAKERS_BPS:  u64 = 6000;
const WORKERS_BPS:  u64 = 2000;
const BURN_BPS:     u64 = 1000;
// remainder → treasury

#[program]
pub mod fee_collector {
    use super::*;

    pub fn distribute(ctx: Context<Distribute>, total: u64) -> Result<()> {
        let vault = &mut ctx.accounts.fee_vault;
        vault.total_collected = vault.total_collected.saturating_add(total);

        let stakers_share  = total * STAKERS_BPS / 10_000;
        let workers_share  = total * WORKERS_BPS / 10_000;
        let burn_share     = total * BURN_BPS    / 10_000;
        let treasury_share = total - stakers_share - workers_share - burn_share;

        emit!(FeeDistributed {
            total,
            stakers:  stakers_share,
            workers:  workers_share,
            burn:     burn_share,
            treasury: treasury_share,
        });
        Ok(())
    }

    pub fn initialize_fee_vault(ctx: Context<InitializeFeeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.fee_vault;
        vault.total_collected = 0;
        vault.bump = ctx.bumps.fee_vault;
        Ok(())
    }
}

#[event]
pub struct FeeDistributed {
    pub total:    u64,
    pub stakers:  u64,
    pub workers:  u64,
    pub burn:     u64,
    pub treasury: u64,
}

#[account]
pub struct FeeVault {
    pub total_collected: u64,
    pub bump:            u8,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut, seeds = [b"fee_vault"], bump = fee_vault.bump)]
    pub fee_vault:  Account<'info, FeeVault>,
    pub authority:  Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeFeeVault<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 8 + 1,
        seeds = [b"fee_vault"],
        bump,
    )]
    pub fee_vault: Account<'info, FeeVault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
