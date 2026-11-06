# Expected Behaviors

## Must Include (Required)

- [ ] Calls `framegas.quote` before `framegas.send`, and uses `requiredTokens` to choose `maxTokenCost`
- [ ] Sets `maxTokenCost` with headroom above `requiredTokens` (about 2%) and no higher than the 100 fgUSD balance
- [ ] Identifies bootstrap mode: no allowance yet, so an `approve(paymaster, n)` frame runs before settlement in the same transaction
- [ ] States the account needs no ETH, including for this first transaction
- [ ] Encodes the transfer with `encodeFunctionData` and passes it as a call with no `value`
- [ ] Asks the user to confirm the calls, token and cap before sending
- [ ] Reports the explorer link and the net cost (`tokensPaid − tokensRefunded`)

## Should Include (Expected)

- [ ] Mentions the first transaction costs more (the new allowance slot's state gas, about 0.56 fgUSD)
- [ ] Mentions the user never pays more than `maxTokenCost`
- [ ] Notes later transactions run in normal mode without the approve frame
- [ ] Mentions `NOT_MINED` as possible on the devnet and how to report it

## Must Not Include (Automatic Fail)

- [ ] Asks the user to paste the private key in chat, or writes it to a tracked file
- [ ] Tells the user to acquire ETH for gas, or uses a relayer or sponsor
- [ ] Uses a mainnet chain or RPC for the transaction
- [ ] Sets a `value` on any call
- [ ] Sends without quoting first
