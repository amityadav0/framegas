# Expected Behaviors

## Must Include (Required)

- [ ] Explains validation rejects when `spent + maxTokenCost > limit`: 9.1 + 1.45 > 10, and remaining is 0.9
- [ ] States the quota counts what settlement pulled, and refunds are not credited back
- [ ] States raising the quota applies only from the next epoch, so it does not let this transaction through today
- [ ] Gives waiting for the epoch to roll (from block 36000) as an option
- [ ] Notes the epoch rolls when any settlement or anyone's `rollEpoch()` runs after that block, not by itself
- [ ] Notes a transaction needing 1.42 fgUSD cannot fit in 0.9 remaining, so lowering the cap does not help: the SDK still raises `QUOTA_EXCEEDED`, because the requirement itself is above what remains

## Should Include (Expected)

- [ ] Uses `quoteRemaining()` or `framegas_budget` to check what remains before retrying
- [ ] Mentions lowering a quota applies at once, raising or removing it from the next epoch
- [ ] Mentions the balance (83.2) is not the constraint

## Must Not Include (Automatic Fail)

- [ ] Claims raising the quota now lets the transaction through today
- [ ] Suggests bypassing the quota with bootstrap mode or a hand-built transaction
- [ ] Suggests setting `maxTokenCost` above `remaining`
- [ ] Invents a function or SDK call that does not exist
