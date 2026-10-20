# Data dictionary

All exports are UTF-8, comma-separated, one header row. Timestamps are ISO 8601 UTC
(`2026-10-19T09:14:03.512Z`). Missing values are blank. **Pilot rows are excluded from
every file** (the status page has separate pilot exports). No file contains names, emails,
student IDs, IP addresses or device data.

## The questionnaires

| When | Survey (`phase`) | Items, in the order shown |
|---|---|---|
| Before the nine questions | `pre` | C1-C6, then P1, P2 |
| Right after Q9, before any score | `post_a` | Q10 |
| *Score reveal: "You answered X of 9 correctly." (same wording for both groups)* | | |
| After the reveal | `post` | C1-C6 (identical to pre), Q11, Q13, Q14, Q12 |

### Codebook

| Item | Text | Values |
|---|---|---|
| C1-C6 | Stem: "How confident are you that you can do each of the following right now?" C1 arrays; C2 sliding-window; C3 two-pointer; C4 read code and work out its output; C5 find the bug; C6 coding problems in general | 1 Not at all confident ... 4 Moderately confident ... 7 Extremely confident |
| P1 | Problems solved on coding practice platforms | 1 = 0, 2 = 1-25, 3 = 26-100, 4 = 101-300, 5 = more than 300 |
| P2 | Practice frequency in the last month | 1 Never, 2 Less than once a week, 3 1-3 days a week, 4 4-6 days a week, 5 Daily |
| Q10 | "Out of the nine questions you just answered, how many do you think you got right?" | 0-9 |
| Q11 | "Compared with the other participants, I think I performed..." | 1 Much worse ... 4 About the same ... 7 Much better |
| Q12 | "During the questions, did you see any badges, tokens or a leaderboard?" (manipulation check, asked last) | 1 Yes, 2 No, 3 Not sure |
| Q13 | "I felt pressure while answering the questions." | 1 Strongly disagree ... 7 Strongly agree |
| Q14 | "I enjoyed doing these questions." | 1 Strongly disagree ... 7 Strongly agree |

P1, P2 and Q12 are categories stored as codes; every export also has their text label.

## participants.csv — one row per participant (the file for the main analysis)

| Column | Meaning |
|---|---|
| participant_code | Random 6-character code shown on the debrief. The only identifier. |
| arm | `control` or `experimental`; blank if they stopped before the pre-survey was submitted |
| arm_code | 0 = control, 1 = experimental |
| status | `completed`, `in_progress` (never finished, did not press stop), `abandoned` (pressed "Stop taking part"), `withdrawn` (asked afterwards for their data to be removed; all their answers are deleted) |
| last_step | Step they were on last: `PRE_SURVEY`, `INSTRUCTIONS`, `QUESTION`, `FEEDBACK`, `POST_SURVEY_A`, `FINAL`, `POST_SURVEY`, `DEBRIEF` |
| started_at_utc / completed_at_utc | Consent given / post-survey submitted |
| duration_s | completed_at - started_at, in seconds |
| questions_answered | Questions with an answer (expired ones do not count) |
| score_raw | Correct answers out of 9. Blank until all nine questions are closed. |
| **pre_conf_mean** | Mean of C1-C6 before the questions (1-7) |
| **post_conf_mean** | Mean of C1-C6 after the score reveal (1-7) |
| **conf_change** | post_conf_mean - pre_conf_mean |
| **calibration_gap** | Q10 - score_raw. Positive = overestimated, negative = underestimated, 0 = accurate |
| C1_pre ... C6_pre | Each confidence item before (for reliability, e.g. Cronbach's alpha) |
| P1, P1_label, P2, P2_label | Background items, code and text |
| Q10 | The guess, 0-9 |
| C1_post ... C6_post | Each confidence item after |
| Q11, Q13, Q14 | 1-7 |
| Q12, Q12_label | Manipulation check, code and text |
| tokens_total | Experimental only: tokens earned (recomputed from stored answers with the game rules) |
| badges_earned | Experimental only: badges earned (out of 8) |
| best_streak | Experimental only: longest run of correct answers in a row |
| level_reached | Experimental only: level number at the end (1 Rookie ... 5 Legend) |
| rank_shown / rank_pool_size | Experimental only: the rank and the number of players shown the first time the score screen opened |
| consent_version | Version string of the consent text they agreed to |

If an item is removed from a survey (for example Q13/Q14 cut for time), its columns disappear.
If a scale item is ever marked `"reverse": true`, it is reverse-coded (min + max - value)
before the means are taken; none of the final items are reverse-coded.

## questions_long.csv — one row per participant × question shown

| Column | Meaning |
|---|---|
| participant_code, arm | As above |
| question_id | Q1-Q9 (the test questions, not the survey items) |
| section | Sliding Window / Two Pointers / Arrays |
| selected_option | A, B, C, D, IDK ("I don't know", if switched on), or blank (expired / never answered) |
| is_correct | 1 or 0 (blank if never answered and not expired) |
| time_taken_ms | answered_at - shown_at. shown_at is the **first** time the question was served, so a refresh does not reset it. |
| answered_at_utc | When the answer was submitted |
| position | Order in which it was shown (1-9) |
| difficulty_label | Easy / Medium / Hard (provisional labels) |
| response_status | `answered`, `expired` (closed by the time limit), `not_answered` (shown, then the participant stopped) |
| shown_at_utc | First time the question was served |

## surveys_long.csv — one row per participant × survey answer

| Column | Meaning |
|---|---|
| participant_code, arm | As above |
| phase | `pre`, `post_a` or `post` |
| item_id | C1-C6, P1, P2, Q10-Q14 |
| value | The code the participant chose |
| value_label | Text of the option, for P1, P2 and Q12 |
| measure | `confidence`, `prior_experience`, `practice_frequency`, `postdiction`, `relative_performance`, `manipulation_check`, `pressure`, `enjoyment` |
| reverse | 1 if the item is reverse-coded (none are) |
| value_scored | value after reverse-coding (what the means use) |

## events.csv — append-only audit log

`participant_code` (blank for system events), `event_type`, `payload` (JSON), `created_at_utc`.
Event types: `consent_given`, `survey_submitted` (with the phase), `arm_assigned`, `instructions_ack`,
`question_shown`, `answer_submitted`, `feedback_ack`, `results_viewed`, `results_ack`,
`completed`, `withdrawn` (pressed stop), `time_expired`, `error` (code + route only, never
participant text), `content_changed`, `backup_taken`, `backup_downloaded`, `study_mode_changed`,
`allocation_extended`, `pilot_data_purged`, `data_withdrawn`.

## gamification_events.csv — experimental group only

- `tokens`: key = question id, value = tokens earned on that answer (including any streak bonus)
- `streak_bonus`: key = question id, value = the bonus part of those tokens
- `badge`: key = badge key, earned on that answer
- `level_up`: key = new level name, value = level number
- `live_rank` / `live_rank_pool`: key = question id; value = how many players they were ahead of / how many players they were compared with (real experimental players who had already answered that question). Only written when there was someone to compare with.
- `leaderboard_view`: key `rank` / `pool_size`: what was shown each time the score screen opened

## allocation.csv — the full allocation list

`seed`, `block_size`, `list` (`main` / `pilot`), `seq_no`, `block_no`, `arm`, `claimed` (0/1),
`participant_code` (blank for unclaimed and pilot slots), `claimed_at_utc`. The list can be
regenerated exactly from the seed: `npm run allocation -- --preview --seed <seed>`.
Slots of participants who stopped are never reused.

## meta.csv

Schema version, storage (`sqlite` or `postgres`), allocation seed and block size, study mode,
the SHA-256 of every content file used, the questions version, and the export time.

## Planned analysis

- Confidence score = mean of C1-C6 (1-7), separately for pre and post.
- Change = post - pre. Calibration = Q10 - score_raw.
- Main test: ANCOVA `post_conf_mean ~ arm_code + pre_conf_mean` on completed participants.
- `scripts/analysis/ancova.py` (or `ancova.R`) runs this, plus Cronbach's alpha for C1-C6,
  the manipulation check by group, calibration, Q11/Q13/Q14 by group and P1/P2 balance.
