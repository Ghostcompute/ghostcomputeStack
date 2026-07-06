use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("3M1YFgQdviR9eFUVVarFgkhGiGyChfN8Nrt5W1zjxbAN");

#[program]
pub mod ghst_staking {
    use super::*;

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        let staker = &mut ctx.accounts.staker;
        staker.owner       = ctx.accounts.owner.key();
        staker.staked_raw  += amount;
        staker.staked_at   = Clock::get()?.unix_timestamp;
        staker.bump        = ctx.bumps.staker;

        let cpi = CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::transfer(cpi, amount)?;
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        let staker = &mut ctx.accounts.staker;
        require!(staker.staked_raw >= amount, StakeError::InsufficientStake);
        staker.staked_raw -= amount;

        let seeds: &[&[&[u8]]] = &[&[b"vault", &[ctx.bumps.vault]]];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            seeds,
        );
        token::transfer(cpi, amount)?;
        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let staker = &mut ctx.accounts.staker;
        let rewards = staker.rewards_raw;
        require!(rewards > 0, StakeError::NoRewards);
        staker.rewards_raw = 0;

        emit!(RewardsClaimed { owner: staker.owner, amount: rewards });
        Ok(())
    }
}

#[error_code]
pub enum StakeError {
    #[msg("Insufficient staked balance")]
    InsufficientStake,
    #[msg("No rewards to claim")]
    NoRewards,
}

#[event]
pub struct RewardsClaimed { pub owner: Pubkey, pub amount: u64 }

#[account]
pub struct StakerAccount {
    pub owner:       Pubkey,
    pub staked_raw:  u64,
    pub rewards_raw: u64,
    pub staked_at:   i64,
    pub bump:        u8,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + 32 + 8 + 8 + 8 + 1,
        seeds = [b"staker", owner.key().as_ref()],
        bump,
    )]
    pub staker:       Account<'info, StakerAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault:        Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token:  Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner:        Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [b"staker", owner.key().as_ref()], bump = staker.bump)]
    pub staker:       Account<'info, StakerAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault:        Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token:  Account<'info, TokenAccount>,
    pub owner:        Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut, seeds = [b"staker", owner.key().as_ref()], bump = staker.bump)]
    pub staker: Account<'info, StakerAccount>,
    pub owner:  Signer<'info>,
}
