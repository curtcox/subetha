# SubEtha pricing invariant report

Generated from `pricing/costs.yaml`. Every SKU at every tier must have a margin ≥ 15% — this report only exists if that held.

| SKU | Unit | Cost | Price (standard) | Price (bulk) | Price (volume) | Margin (standard) | Margin (bulk) | Margin (volume) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `publish` | message | $0.0000015 | $0.000006 | $0.000006 | $0.000006 | 75.0% | 75.0% | 75.0% |
| `deliver_live` | delivery | $0.0000003 | $0.000002 | $0.000002 | $0.000001 | 85.0% | 85.0% | 70.0% |
| `deliver_push` | delivery | $0.000002 | $0.000006 | $0.000006 | $0.000005 | 66.7% | 66.7% | 60.0% |
| `deliver_webhook` | delivery | $0.0000023 | $0.00001 | $0.00001 | $0.000009 | 77.0% | 77.0% | 74.4% |
| `deliver_slack` | delivery | $0.0000023 | $0.00001 | $0.00001 | $0.000009 | 77.0% | 77.0% | 74.4% |
| `deliver_mcp` | delivery | $0.00000085 | $0.000007 | $0.000007 | $0.000007 | 87.9% | 87.9% | 87.9% |
| `deliver_email` | email | $0.0001212 | $0.000443 | $0.000413 | $0.000382 | 72.6% | 70.7% | 68.3% |
| `inbound_email` | email | $0.00001 | $0.00007 | $0.000068 | $0.000065 | 85.7% | 85.3% | 84.6% |
| `deliver_sms_us` | segment | $0.0115 | $0.0166 | $0.0155 | $0.0143 | 30.7% | 25.6% | 19.6% |
| `inbound_sms_us` | segment | $0.0110 | $0.0159 | $0.0148 | $0.0137 | 30.8% | 25.7% | 19.7% |
| `deliver_voice_us` | minute | $0.0169 | $0.0247 | $0.0230 | $0.0213 | 31.5% | 26.4% | 20.6% |
| `deliver_sms_intl` | segment | $0.0505 | $0.0717 | $0.0667 | $0.0616 | 29.6% | 24.2% | 18.0% |
| `deliver_voice_intl` | minute | $0.0534 | $0.0768 | $0.0714 | $0.0661 | 30.4% | 25.2% | 19.2% |
| `deliver_lxmf` | delivery | $0.0000152 | $0.000051 | $0.000047 | $0.000043 | 70.2% | 67.7% | 64.6% |
| `api_request` | request | $0.000001 | $0.000003 | $0.000003 | $0.000003 | 66.7% | 66.7% | 66.7% |
| `attachment_upload` | upload | $0.0000068 | $0.000017 | $0.000015 | $0.000014 | 60.0% | 54.7% | 51.4% |
| `retention_message_day` | message-day | $0.00000004 | $0.0000001 | $0.00000009 | $0.00000008 | 60.0% | 55.6% | 50.0% |
| `attachment_mb_day` | MB-day | $0.0000006 | $0.0000016 | $0.00000145 | $0.0000013 | 62.5% | 58.6% | 53.8% |
| `device_day` | device-day | $0.0000005 | $0.000002 | $0.000001875 | $0.00000175 | 75.0% | 73.3% | 71.4% |
| `endpoint_day` | endpoint-day | $0.0000021 | $0.0000092 | $0.000008675 | $0.00000815 | 77.2% | 75.8% | 74.2% |
| `connection_hour` | connection-hour | $0.000001 | $0.000003 | $0.00000275 | $0.0000025 | 66.7% | 63.6% | 60.0% |

Edge transports (BLE, audio, QR, LAN) never touch the relay and are free.

## Fixed costs and break-even

| Item | USD / month |
|---|---:|
| cloudflare_workers_paid | $5.00 |
| cloudflare_containers_base | $5.00 |
| domain_subetha_org | $1.25 |
| clerk_pro | $25.00 |
| twilio_number | $1.15 |
| twilio_10dlc_campaign | $10.00 |
| apple_developer | $8.25 |
| google_play | $0.00 |
| github | $0.00 |
| monitoring_status_page | $0.00 |
| **Total** | **$55.65** |

- Top-up fee: 4.5% + $0.35. On an average $20 top-up (domestic card) it contributes $0.370 to fixed costs.
- Break-even on top-up fees alone: **151 top-ups / month**.
- Margin per published message with 2 live deliveries: $0.0000079; break-even on messages alone: **7,044,304 messages / month**.
- Profit = Σ(volume × unit margin) − fixed costs, so it only rises with volume.
