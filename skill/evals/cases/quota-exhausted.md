# Quota Used Up

My agent pays gas in fgUSD through FrameGas with a daily quota of 10 fgUSD that I
set with `setQuota`. Today `framegas_budget` reports:

```json
{
  "token": "fgUSD",
  "balance": "83.2",
  "allowance": "40",
  "quota": { "active": true, "limit": "10", "spent": "9.1", "remaining": "0.9", "epoch": 4, "resetsAtBlock": "36000" }
}
```

The next call it wants to make quotes at `requiredTokens: "1.42"`. The agent
tried `framegas_send` with `maxTokenCost: "1.45"` and got
`{ "error": { "code": "QUOTA_EXCEEDED" } }`.

## Requirements

1. Explain why it failed and what the quota counts.
2. Give the options, with what each one does and when it takes effect.
3. Say whether raising the quota now lets this transaction through today.
