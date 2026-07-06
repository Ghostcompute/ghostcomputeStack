use anchor_lang::prelude::*;

declare_id!("DBm8msZ7Z7fM1AX7NQYpmrQS2g55AKxSUVAcFNmo6vqk");

#[program]
pub mod dark_pool {
    use super::*;

    pub fn place_order(ctx: Context<PlaceOrder>, params: PlaceOrderParams) -> Result<()> {
        let order = &mut ctx.accounts.order;
        order.id         = params.id;
        order.owner      = ctx.accounts.owner.key();
        order.side       = params.side;
        order.base_mint  = ctx.accounts.base_mint.key();
        order.quote_mint = ctx.accounts.quote_mint.key();
        order.amount     = params.amount;
        order.price      = params.price;
        order.guarantee  = params.guarantee;
        order.status     = 0; // open
        order.created_at = Clock::get()?.unix_timestamp;
        order.bump       = ctx.bumps.order;
        Ok(())
    }

    pub fn settle_match(ctx: Context<SettleMatch>, match_id: [u8; 16], fill_amount: u64, fill_price: u64) -> Result<()> {
        ctx.accounts.buy_order.status  = 2; // matched
        ctx.accounts.sell_order.status = 2;
        emit!(MatchEvent { match_id, fill_amount, fill_price });
        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &mut ctx.accounts.order;
        require!(order.status == 0, DarkPoolError::NotOpen);
        order.status = 3; // cancelled
        Ok(())
    }

    // ── Confidential path (P9) ──────────────────────────────────────
    // The resting book never stores amount/price on-chain: only a commitment
    // hash (to the sealed order) + posted margin. The opening is revealed and
    // checked in-enclave / via Arcium at match time.

    pub fn submit_sealed_order(
        ctx: Context<SubmitSealedOrder>,
        params: SealedOrderParams,
    ) -> Result<()> {
        let order = &mut ctx.accounts.sealed_order;
        order.id          = params.id;
        order.owner       = ctx.accounts.owner.key();
        order.commit_hash = params.commit_hash;
        order.margin      = params.margin;
        order.guarantee   = params.guarantee;
        order.status      = 0; // sealed
        order.created_at  = Clock::get()?.unix_timestamp;
        order.bump        = ctx.bumps.sealed_order;
        emit!(SealedOrderSubmitted { id: params.id, owner: order.owner, commit_hash: params.commit_hash });
        Ok(())
    }

    /// Settle a matched sealed order — reveals ONLY the cleared fill.
    pub fn settle_sealed_fill(
        ctx: Context<SettleSealedFill>,
        match_id: [u8; 16],
        fill_amount: u64,
        fill_price: u64,
    ) -> Result<()> {
        ctx.accounts.buy_order.status  = 2; // matched
        ctx.accounts.sell_order.status = 2;
        emit!(MatchEvent { match_id, fill_amount, fill_price });
        Ok(())
    }

    pub fn cancel_sealed_order(ctx: Context<CancelSealedOrder>) -> Result<()> {
        let order = &mut ctx.accounts.sealed_order;
        require!(order.status == 0, DarkPoolError::NotOpen);
        order.status = 3; // cancelled
        Ok(())
    }
}

#[event]
pub struct MatchEvent {
    pub match_id:    [u8; 16],
    pub fill_amount: u64,
    pub fill_price:  u64,
}

#[error_code]
pub enum DarkPoolError {
    #[msg("Order is not open")]
    NotOpen,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlaceOrderParams {
    pub id:        [u8; 16],
    pub side:      u8,   // 0=buy, 1=sell
    pub amount:    u64,
    pub price:     u64,
    pub guarantee: u8,
}

#[account]
pub struct OrderAccount {
    pub id:         [u8; 16],
    pub owner:      Pubkey,
    pub side:       u8,
    pub base_mint:  Pubkey,
    pub quote_mint: Pubkey,
    pub amount:     u64,
    pub price:      u64,
    pub guarantee:  u8,
    pub status:     u8,
    pub created_at: i64,
    pub bump:       u8,
}

#[derive(Accounts)]
#[instruction(params: PlaceOrderParams)]
pub struct PlaceOrder<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 16 + 32 + 1 + 32 + 32 + 8 + 8 + 1 + 1 + 8 + 1,
        seeds = [b"order", params.id.as_ref()],
        bump,
    )]
    pub order:      Account<'info, OrderAccount>,
    /// CHECK: Mint pubkey validated off-chain; token transfers happen in a later settlement ix.
    pub base_mint:  AccountInfo<'info>,
    /// CHECK: Mint pubkey validated off-chain; token transfers happen in a later settlement ix.
    pub quote_mint: AccountInfo<'info>,
    #[account(mut)]
    pub owner:      Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    #[account(mut)]
    pub buy_order:  Account<'info, OrderAccount>,
    #[account(mut)]
    pub sell_order: Account<'info, OrderAccount>,
    pub oracle:     Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut, seeds = [b"order", order.id.as_ref()], bump = order.bump)]
    pub order: Account<'info, OrderAccount>,
    pub owner: Signer<'info>,
}

// ── Confidential / sealed order accounts (P9) ──────────────────────────────

#[event]
pub struct SealedOrderSubmitted {
    pub id:          [u8; 16],
    pub owner:       Pubkey,
    pub commit_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SealedOrderParams {
    pub id:          [u8; 16],
    pub commit_hash: [u8; 32], // commitment to the sealed (side, amount, price, blinding)
    pub margin:      u64,      // posted collateral (public)
    pub guarantee:   u8,
}

#[account]
pub struct SealedOrderAccount {
    pub id:          [u8; 16],
    pub owner:       Pubkey,
    pub commit_hash: [u8; 32],
    pub margin:      u64,
    pub guarantee:   u8,
    pub status:      u8, // 0=sealed,2=matched,3=cancelled
    pub created_at:  i64,
    pub bump:        u8,
}

#[derive(Accounts)]
#[instruction(params: SealedOrderParams)]
pub struct SubmitSealedOrder<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 16 + 32 + 32 + 8 + 1 + 1 + 8 + 1,
        seeds = [b"sealed_order", params.id.as_ref()],
        bump,
    )]
    pub sealed_order: Account<'info, SealedOrderAccount>,
    #[account(mut)]
    pub owner:        Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleSealedFill<'info> {
    #[account(mut)]
    pub buy_order:  Account<'info, SealedOrderAccount>,
    #[account(mut)]
    pub sell_order: Account<'info, SealedOrderAccount>,
    pub oracle:     Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelSealedOrder<'info> {
    #[account(mut, seeds = [b"sealed_order", sealed_order.id.as_ref()], bump = sealed_order.bump)]
    pub sealed_order: Account<'info, SealedOrderAccount>,
    pub owner:        Signer<'info>,
}
