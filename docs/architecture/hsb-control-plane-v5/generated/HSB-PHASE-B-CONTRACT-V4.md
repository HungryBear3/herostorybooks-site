# HSB Phase B Contract V4

Status: `DECISIONS_COMPLETE_OFFLINE_CANDIDATE`

Provider qualification: `HOLD_UNQUALIFIED`

Canonical registry SHA-256: `964695a89f250b07ef0bcb0a6b15deee9e33af6036c1a0bc0650d2d5bd014fa0`

This generated implementation plan references the same registry IDs. Implementation and activation remain separately unauthorized.

Handwritten guidance refers to registry IDs; the generated sections are the sole table definitions.

<!-- BEGIN GENERATED REGISTRIES -->

<section data-registry="acceptance_tests">

## Registry `acceptance_tests`

```json
{
  "groups": [
    "T-R4",
    "T-P6",
    "T-P8",
    "W4-W5",
    "W10",
    "capability",
    "stages_roles",
    "cutover",
    "revisions",
    "projections",
    "states",
    "facts",
    "replay_conflict",
    "event_matrix",
    "reversal_first",
    "risk",
    "harness",
    "duplicate_detector",
    "legacy_activation",
    "disputes"
  ],
  "name": "acceptance_tests"
}
```

</section>

<section data-registry="activation_closure_queries">

## Registry `activation_closure_queries`

```json
{
  "changed_bytes_create_immutable_revision": true,
  "consumes_registry": "legacy_source_classes",
  "equations": [
    {
      "id": "source_count_matches",
      "lhs": "source_count",
      "op": "eq_metric",
      "rhs": "classified_mapping_count"
    },
    {
      "id": "unclassified_zero",
      "lhs": "unclassified_count",
      "op": "eq_value",
      "rhs": 0
    },
    {
      "id": "duplicate_source_identity_zero",
      "lhs": "duplicate_source_identity_count",
      "op": "eq_value",
      "rhs": 0
    },
    {
      "id": "unknown_zero",
      "lhs": "unknown_count",
      "op": "eq_value",
      "rhs": 0
    },
    {
      "id": "conflict_zero",
      "lhs": "conflict_count",
      "op": "eq_value",
      "rhs": 0
    },
    {
      "id": "open_unmapped_exposure_zero",
      "lhs": "open_unmapped_exposure_count",
      "op": "eq_value",
      "rhs": 0
    },
    {
      "id": "classification_digests_equal",
      "lhs": "classification_digest_run_1",
      "op": "eq_metric",
      "rhs": "classification_digest_run_2"
    },
    {
      "id": "source_delta_zero",
      "lhs": "source_delta_between_runs",
      "op": "eq_value",
      "rhs": 0
    }
  ],
  "metric_domain": [
    "source_count",
    "classified_mapping_count",
    "unclassified_count",
    "duplicate_source_identity_count",
    "unknown_count",
    "conflict_count",
    "open_unmapped_exposure_count",
    "classification_digest_run_1",
    "classification_digest_run_2",
    "source_delta_between_runs"
  ],
  "name": "activation_closure_queries",
  "operator_domain": [
    "eq_metric",
    "eq_value"
  ],
  "unknown_conflict_unmapped_blocks_activation": true
}
```

</section>

<section data-registry="authority_boundaries">

## Registry `authority_boundaries`

```json
{
  "activation": "unauthorized",
  "documentation": "offline_candidate_only",
  "external_operations": "unauthorized",
  "implementation": "unauthorized",
  "name": "authority_boundaries",
  "provider_qualification": "HOLD_UNQUALIFIED"
}
```

</section>

<section data-registry="backfill_revision_protocol">

## Registry `backfill_revision_protocol`

```json
{
  "append_cardinality": 1,
  "canonical_row_order": [
    "source_identity",
    "source_version",
    "source_digest"
  ],
  "changed_source": "new_immutable_source_version_revision",
  "checkpoint_transaction": "enumeration_commits_before_mapping",
  "input_registry": "immutable_full_source_fact_rows",
  "name": "backfill_revision_protocol",
  "observation": "one_strict_legacy_source_fact",
  "post_append_activation": "both_enumerations_equal_complete_immutable_revision_set_with_exact_digests",
  "prior_rows_preserved_exactly": true,
  "promotion": "only_compatible_nonauthoritative_nonexposed_never_reused",
  "rejection_reasons": [
    "malformed_prior_row",
    "duplicate_prior_revision_key",
    "malformed_observed_source_fact",
    "unknown_source_identity",
    "immutable_revision_overwrite",
    "unchanged_bytes_new_revision"
  ],
  "result_domain": [
    "append",
    "noop",
    "reject"
  ],
  "reused_payable_conflict": "quarantine_activation_blocker",
  "rollback": "mark_inert_never_delete_immutable_history",
  "transition_branches": [
    "exact_tuple_noop",
    "same_version_changed_digest_reject",
    "new_version_unchanged_digest_reject",
    "new_version_changed_digest_append",
    "malformed_prior_reject",
    "duplicate_prior_key_reject",
    "unknown_identity_reject",
    "canonical_order_stable",
    "input_immutable"
  ],
  "transition_table": [
    {
      "result": "noop",
      "when": "same_identity_same_version_same_digest"
    },
    {
      "reason": "immutable_revision_overwrite",
      "result": "reject",
      "when": "same_identity_same_version_changed_digest"
    },
    {
      "reason": "unchanged_bytes_new_revision",
      "result": "reject",
      "when": "same_identity_new_version_unchanged_digest"
    },
    {
      "append_count": 1,
      "result": "append",
      "when": "same_identity_new_version_changed_digest"
    }
  ]
}
```

</section>

<section data-registry="capability_resolution">

## Registry `capability_resolution`

```json
{
  "canonical_fingerprint_mismatch": "refuse_and_require_capability_authenticated_start_new_purchase",
  "content_email_fingerprint_are_authorization": false,
  "name": "capability_resolution",
  "precedence": [
    "usable_handles_multiple_scopes_refuse",
    "any_recognized_unusable_refuse",
    "usable_handles_one_scope_resolve",
    "absent_malformed_unrecognized_mint_new_scope"
  ],
  "request_time_legacy_blob_adoption": false
}
```

</section>

<section data-registry="charge_risk_precedence">

## Registry `charge_risk_precedence`

```json
{
  "historical_resolution": "append_only",
  "name": "charge_risk_precedence",
  "not_charged_requires_nonempty_generations": true,
  "zero_generations": "provider_not_invoked"
}
```

</section>

<section data-registry="containment_projection">

## Registry `containment_projection`

```json
{
  "mapping": {
    "abandoned": "abandoned",
    "ambiguous": "ambiguous",
    "blocked": "blocked",
    "draft": "draft",
    "paid": "paid",
    "payable": "ambiguous",
    "provisioning": "ambiguous",
    "reversed": "reversed"
  },
  "name": "containment_projection",
  "preserves_blocked_from": true,
  "preserves_independent_holds": true,
  "sets_fulfillment_hold": true,
  "sets_risk_hold": true
}
```

</section>

<section data-registry="crash_outcomes">

## Registry `crash_outcomes`

```json
{
  "name": "crash_outcomes",
  "values": [
    "W4_readback_reserved_written_ready",
    "W5_written_or_ready_exact_replay",
    "W8_marker_readback_one_create",
    "S1_bare_marker_no_age_release",
    "W9_exact_candidate_or_conflict",
    "W10_same_bind_idempotent_difference_conflict",
    "W11_CF_only_atomic_supersession",
    "W12_atomic_apply_or_retryable_expiry",
    "E1_processing_state_replay",
    "E2_contained_digest_conflict",
    "R1_identity_locked_reversal_consumption",
    "C1_platform_old_writer_barrier",
    "C2_revision_promote_or_quarantine",
    "H1_outage_latch_unadmitted_restart"
  ]
}
```

</section>

<section data-registry="cutover_barrier">

## Registry `cutover_barrier`

```json
{
  "application_lease_alone_sufficient": false,
  "name": "cutover_barrier",
  "requirements": [
    "zero_old_deployment_routing",
    "termination_or_drain_all_old_instances",
    "zero_inflight",
    "wait_beyond_certified_max_duration_plus_skew",
    "automatic_rollback_disabled",
    "two_identical_enumerations",
    "complete_immutable_revision_registry_match",
    "zero_delta"
  ]
}
```

</section>

<section data-registry="dispute_edges_with_guards">

## Registry `dispute_edges_with_guards`

```json
{
  "all_unlisted_rejected": true,
  "edges": [
    {
      "from": "none",
      "guard": "first_open_evidence",
      "incoming": "open",
      "to": "open"
    },
    {
      "from": "none",
      "guard": "first_won_evidence",
      "incoming": "won",
      "to": "won"
    },
    {
      "from": "none",
      "guard": "first_lost_evidence",
      "incoming": "lost",
      "to": "lost"
    },
    {
      "from": "open",
      "guard": "compatible_open_evidence",
      "incoming": "open",
      "to": "open"
    },
    {
      "from": "open",
      "guard": "won_evidence",
      "incoming": "won",
      "to": "won"
    },
    {
      "from": "open",
      "guard": "lost_evidence",
      "incoming": "lost",
      "to": "lost"
    },
    {
      "from": "won",
      "guard": "stale_open_preserves_terminal",
      "incoming": "open",
      "to": "won"
    },
    {
      "from": "won",
      "guard": "compatible_won_evidence",
      "incoming": "won",
      "to": "won"
    },
    {
      "from": "won",
      "guard": "opposite_lost_evidence",
      "incoming": "lost",
      "to": "conflict"
    },
    {
      "from": "lost",
      "guard": "stale_open_preserves_terminal",
      "incoming": "open",
      "to": "lost"
    },
    {
      "from": "lost",
      "guard": "opposite_won_evidence",
      "incoming": "won",
      "to": "conflict"
    },
    {
      "from": "lost",
      "guard": "compatible_lost_evidence",
      "incoming": "lost",
      "to": "lost"
    },
    {
      "from": "conflict",
      "guard": "all_later_evidence",
      "incoming": "open",
      "to": "conflict"
    },
    {
      "from": "conflict",
      "guard": "all_later_evidence",
      "incoming": "won",
      "to": "conflict"
    },
    {
      "from": "conflict",
      "guard": "all_later_evidence",
      "incoming": "lost",
      "to": "conflict"
    }
  ],
  "name": "dispute_edges_with_guards"
}
```

</section>

<section data-registry="dispute_states">

## Registry `dispute_states`

```json
{
  "name": "dispute_states",
  "values": [
    "none",
    "open",
    "won",
    "lost",
    "conflict"
  ]
}
```

</section>

<section data-registry="dispute_transition_function">

## Registry `dispute_transition_function`

```json
{
  "mapping": {
    "conflict|lost": "conflict",
    "conflict|open": "conflict",
    "conflict|won": "conflict",
    "lost|lost": "lost",
    "lost|open": "lost",
    "lost|won": "conflict",
    "none|lost": "lost",
    "none|open": "open",
    "none|won": "won",
    "open|lost": "lost",
    "open|open": "open",
    "open|won": "won",
    "won|lost": "conflict",
    "won|open": "won",
    "won|won": "won"
  },
  "name": "dispute_transition_function",
  "opposite_terminal_asserts_holds": true,
  "stale_open_after_terminal": true,
  "won_releases_only_dispute_hold": true
}
```

</section>

<section data-registry="document_readiness">

## Registry `document_readiness`

```json
{
  "edges": [
    "absent>reserved",
    "reserved>written_unverified",
    "written_unverified>ready",
    "reserved>failed",
    "written_unverified>failed",
    "ready>superseded"
  ],
  "immutable_ready_identity": true,
  "name": "document_readiness",
  "w4_w5_readback_states": [
    "reserved",
    "written_unverified",
    "ready"
  ]
}
```

</section>

<section data-registry="duplicate_detector_rules">

## Registry `duplicate_detector_rules`

```json
{
  "case_kind": "duplicate_canonical_order",
  "case_unique_key": [
    "scope_id",
    "case_kind",
    "detector_version"
  ],
  "deduplicate_input_by": "canonical_order_id",
  "detector_version": "duplicate-canonical-order-v1",
  "name": "duplicate_detector_rules",
  "open_order_provider_create_allowed_after_case": false,
  "outcomes": {
    "identity_or_mapping_conflict": "scope_case_plus_identity_conflict_evidence",
    "multiple_open_exposed": "scope_case_hold_all",
    "multiple_paid_reversed": "scope_case_preserve_accounting_hold_fulfillment",
    "one_order_only": "no_case",
    "one_paid_one_open": "scope_case_preserve_paid_hold_open",
    "same_order_through_aliases": "no_case"
  },
  "rerun_mutates_accounting": false
}
```

</section>

<section data-registry="effect_claim_contract">

## Registry `effect_claim_contract`

```json
{
  "claim_rechecks": [
    "order_hold",
    "scope_hold",
    "global_payment_effect_hold"
  ],
  "effects": [
    "email",
    "access",
    "print",
    "fulfillment",
    "release",
    "fulfillment_notification"
  ],
  "hold_blocks_claim": true,
  "name": "effect_claim_contract"
}
```

</section>

<section data-registry="event_evidence_policy">

## Registry `event_evidence_policy`

```json
{
  "all_other_pairs": "durable_containment",
  "dispute_delegation_pairs": [
    {
      "event": "dispute_created",
      "evidence": "DC",
      "incoming": "open"
    },
    {
      "event": "dispute_updated",
      "evidence": "DU",
      "incoming": "open"
    },
    {
      "event": "dispute_won",
      "evidence": "DW",
      "incoming": "won"
    },
    {
      "event": "dispute_lost_or_closed",
      "evidence": "DL",
      "incoming": "lost"
    }
  ],
  "event_domain_registry": "event_families",
  "evidence_domain_registry": "evidence_classes",
  "full_reversal_pairs": [
    [
      "charge_or_refund_update",
      "RF"
    ]
  ],
  "name": "event_evidence_policy",
  "success_pairs": [
    [
      "checkout.session.completed",
      "S+"
    ],
    [
      "checkout.session.completed",
      "S0"
    ],
    [
      "checkout.session.async_payment_succeeded",
      "S+"
    ],
    [
      "payment_intent.succeeded",
      "S+"
    ]
  ]
}
```

</section>

<section data-registry="event_families">

## Registry `event_families`

```json
{
  "name": "event_families",
  "values": [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge_or_refund_update",
    "dispute_created",
    "dispute_updated",
    "dispute_won",
    "dispute_lost_or_closed",
    "unsupported_authenticated"
  ]
}
```

</section>

<section data-registry="event_outcome_matrix">

## Registry `event_outcome_matrix`

```json
{
  "dimensions": {
    "event_families": "event_families",
    "evidence_classes": "evidence_classes",
    "states": "order_states"
  },
  "name": "event_outcome_matrix",
  "outcomes": {
    "dispute_delegation": {
      "delegates_to": "dispute_transition_function",
      "processing": "composed_guarded_transition_200"
    },
    "durable_containment": {
      "creates_or_reuses_case": true,
      "fulfillment_hold": true,
      "processing": "durable_containment_then_200_else_5xx",
      "risk_hold": true,
      "state_targets_registry": "containment_projection"
    },
    "full_reversal": {
      "fulfillment_hold": true,
      "processing": "applied_or_contained_200",
      "risk_hold": true,
      "state_targets": {
        "abandoned": "abandoned",
        "ambiguous": "ambiguous",
        "blocked": "blocked",
        "draft": "draft",
        "paid": "reversed",
        "payable": "ambiguous",
        "provisioning": "ambiguous",
        "reversed": "reversed"
      }
    },
    "success": {
      "fulfillment_hold": "derived_after_complete_alias_consumption",
      "processing": "applied_200",
      "risk_hold": "preserve",
      "state_targets": {
        "abandoned": "abandoned",
        "ambiguous": "paid",
        "blocked": "paid",
        "draft": "draft",
        "paid": "paid",
        "payable": "paid",
        "provisioning": "paid",
        "reversed": "reversed"
      }
    }
  },
  "selection": "event_evidence_policy_then_state_projection"
}
```

</section>

<section data-registry="event_processing_states">

## Registry `event_processing_states`

```json
{
  "different_digest": "durable_hold_case_before_200_and_effect_claim_recheck",
  "exact_replay": {
    "applied": "200_noop",
    "expired_leased": "token_fenced_reacquire",
    "live_leased": "409_retry_after",
    "quarantined": "200_noop_after_durable_containment",
    "received": "reacquire",
    "retryable_failure": "reacquire"
  },
  "name": "event_processing_states",
  "owner_token_fencing": true,
  "values": [
    "received",
    "leased",
    "retryable_failure",
    "applied",
    "quarantined"
  ]
}
```

</section>

<section data-registry="evidence_classes">

## Registry `evidence_classes`

```json
{
  "failed_pi_class": "FP",
  "name": "evidence_classes",
  "partial_refund": "paid_with_risk_and_fulfillment_hold",
  "values": [
    "S+",
    "S0",
    "CF",
    "FP",
    "RP",
    "RF",
    "DC",
    "DU",
    "DW",
    "DL",
    "X"
  ]
}
```

</section>

<section data-registry="exposed_order_classes">

## Registry `exposed_order_classes`

```json
{
  "name": "exposed_order_classes",
  "values": [
    "marker",
    "candidate",
    "session",
    "payment_intent",
    "unknown_provider_outcome",
    "payable",
    "ambiguous",
    "paid",
    "reversed_financial_evidence"
  ]
}
```

</section>

<section data-registry="legacy_classification_rules">

## Registry `legacy_classification_rules`

```json
{
  "enumeration": "exhaustive_modeled_fact_product",
  "match_cardinality": "exactly_one_declared_predicate",
  "name": "legacy_classification_rules",
  "output_total_and_exclusive": true,
  "predicate_language": [
    "always",
    "all",
    "any",
    "not",
    "eq",
    "in",
    "true"
  ],
  "rules": [
    {
      "class": "conflict",
      "predicate": {
        "any": [
          {
            "true": "identity_conflict"
          },
          {
            "true": "mapping_conflict"
          },
          {
            "all": [
              {
                "true": "terminal_charge_free_proven"
              },
              {
                "any": [
                  {
                    "not": {
                      "eq": [
                        "marker",
                        "absent"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "session",
                        "absent"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "payment_intent",
                        "absent"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "reversal",
                        "absent"
                      ]
                    }
                  }
                ]
              }
            ]
          },
          {
            "all": [
              {
                "eq": [
                  "candidate",
                  "absent"
                ]
              },
              {
                "in": [
                  "session",
                  [
                    "unpaid",
                    "paid"
                  ]
                ]
              }
            ]
          },
          {
            "all": [
              {
                "eq": [
                  "session",
                  "paid"
                ]
              },
              {
                "in": [
                  "payment_intent",
                  [
                    "unsettled",
                    "failed",
                    "reversed"
                  ]
                ]
              }
            ]
          },
          {
            "all": [
              {
                "eq": [
                  "session",
                  "unpaid"
                ]
              },
              {
                "in": [
                  "payment_intent",
                  [
                    "succeeded",
                    "reversed"
                  ]
                ]
              }
            ]
          },
          {
            "all": [
              {
                "in": [
                  "reversal",
                  [
                    "full",
                    "dispute_lost"
                  ]
                ]
              },
              {
                "in": [
                  "payment_intent",
                  [
                    "absent",
                    "unsettled",
                    "failed",
                    "unknown"
                  ]
                ]
              }
            ]
          },
          {
            "all": [
              {
                "eq": [
                  "reversal",
                  "partial"
                ]
              },
              {
                "in": [
                  "payment_intent",
                  [
                    "absent",
                    "unsettled",
                    "failed",
                    "reversed"
                  ]
                ]
              },
              {
                "not": {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              }
            ]
          },
          {
            "all": [
              {
                "eq": [
                  "payment_intent",
                  "reversed"
                ]
              },
              {
                "eq": [
                  "reversal",
                  "partial"
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "class": "reversed",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "any": [
              {
                "eq": [
                  "payment_intent",
                  "reversed"
                ]
              },
              {
                "in": [
                  "reversal",
                  [
                    "full",
                    "dispute_lost"
                  ]
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "class": "paid",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "any": [
              {
                "eq": [
                  "payment_intent",
                  "succeeded"
                ]
              },
              {
                "eq": [
                  "session",
                  "paid"
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "class": "terminal_charge_free",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "succeeded"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              ]
            }
          },
          {
            "all": [
              {
                "true": "terminal_charge_free_proven"
              },
              {
                "eq": [
                  "marker",
                  "absent"
                ]
              },
              {
                "eq": [
                  "candidate",
                  "absent"
                ]
              },
              {
                "eq": [
                  "session",
                  "absent"
                ]
              },
              {
                "eq": [
                  "payment_intent",
                  "absent"
                ]
              },
              {
                "eq": [
                  "reversal",
                  "absent"
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "class": "payment_intent_unsettled",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "succeeded"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "all": [
                {
                  "true": "terminal_charge_free_proven"
                },
                {
                  "eq": [
                    "marker",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "candidate",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "absent"
                  ]
                }
              ]
            }
          },
          {
            "eq": [
              "payment_intent",
              "unsettled"
            ]
          }
        ]
      }
    },
    {
      "class": "session_bound_unpaid",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "succeeded"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "all": [
                {
                  "true": "terminal_charge_free_proven"
                },
                {
                  "eq": [
                    "marker",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "candidate",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "absent"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "eq": [
                "payment_intent",
                "unsettled"
              ]
            }
          },
          {
            "eq": [
              "session",
              "unpaid"
            ]
          }
        ]
      }
    },
    {
      "class": "candidate_unbound",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "succeeded"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "all": [
                {
                  "true": "terminal_charge_free_proven"
                },
                {
                  "eq": [
                    "marker",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "candidate",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "absent"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "eq": [
                "payment_intent",
                "unsettled"
              ]
            }
          },
          {
            "not": {
              "eq": [
                "session",
                "unpaid"
              ]
            }
          },
          {
            "eq": [
              "candidate",
              "unbound"
            ]
          }
        ]
      }
    },
    {
      "class": "marker_only",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "succeeded"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "all": [
                {
                  "true": "terminal_charge_free_proven"
                },
                {
                  "eq": [
                    "marker",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "candidate",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "absent"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "eq": [
                "payment_intent",
                "unsettled"
              ]
            }
          },
          {
            "not": {
              "eq": [
                "session",
                "unpaid"
              ]
            }
          },
          {
            "not": {
              "eq": [
                "candidate",
                "unbound"
              ]
            }
          },
          {
            "eq": [
              "marker",
              "present"
            ]
          }
        ]
      }
    },
    {
      "class": "pending_no_provider",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "session",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "unknown"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "unknown"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "reversed"
                  ]
                },
                {
                  "in": [
                    "reversal",
                    [
                      "full",
                      "dispute_lost"
                    ]
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "any": [
                {
                  "eq": [
                    "payment_intent",
                    "succeeded"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "paid"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "all": [
                {
                  "true": "terminal_charge_free_proven"
                },
                {
                  "eq": [
                    "marker",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "candidate",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "session",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "payment_intent",
                    "absent"
                  ]
                },
                {
                  "eq": [
                    "reversal",
                    "absent"
                  ]
                }
              ]
            }
          },
          {
            "not": {
              "eq": [
                "payment_intent",
                "unsettled"
              ]
            }
          },
          {
            "not": {
              "eq": [
                "session",
                "unpaid"
              ]
            }
          },
          {
            "not": {
              "eq": [
                "candidate",
                "unbound"
              ]
            }
          },
          {
            "not": {
              "eq": [
                "marker",
                "present"
              ]
            }
          },
          {
            "all": [
              {
                "not": {
                  "true": "terminal_charge_free_proven"
                }
              },
              {
                "eq": [
                  "marker",
                  "absent"
                ]
              },
              {
                "eq": [
                  "candidate",
                  "absent"
                ]
              },
              {
                "eq": [
                  "session",
                  "absent"
                ]
              },
              {
                "eq": [
                  "payment_intent",
                  "absent"
                ]
              },
              {
                "eq": [
                  "reversal",
                  "absent"
                ]
              }
            ]
          }
        ]
      }
    },
    {
      "class": "unknown",
      "predicate": {
        "all": [
          {
            "not": {
              "any": [
                {
                  "true": "identity_conflict"
                },
                {
                  "true": "mapping_conflict"
                },
                {
                  "all": [
                    {
                      "true": "terminal_charge_free_proven"
                    },
                    {
                      "any": [
                        {
                          "not": {
                            "eq": [
                              "marker",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "candidate",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "session",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "payment_intent",
                              "absent"
                            ]
                          }
                        },
                        {
                          "not": {
                            "eq": [
                              "reversal",
                              "absent"
                            ]
                          }
                        }
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "candidate",
                        "absent"
                      ]
                    },
                    {
                      "in": [
                        "session",
                        [
                          "unpaid",
                          "paid"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "paid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "succeeded",
                          "reversed"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "in": [
                        "reversal",
                        [
                          "full",
                          "dispute_lost"
                        ]
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "unknown"
                        ]
                      ]
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    },
                    {
                      "in": [
                        "payment_intent",
                        [
                          "absent",
                          "unsettled",
                          "failed",
                          "reversed"
                        ]
                      ]
                    },
                    {
                      "not": {
                        "eq": [
                          "session",
                          "paid"
                        ]
                      }
                    }
                  ]
                },
                {
                  "all": [
                    {
                      "eq": [
                        "payment_intent",
                        "reversed"
                      ]
                    },
                    {
                      "eq": [
                        "reversal",
                        "partial"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "any": [
              {
                "any": [
                  {
                    "eq": [
                      "session",
                      "unknown"
                    ]
                  },
                  {
                    "eq": [
                      "payment_intent",
                      "unknown"
                    ]
                  },
                  {
                    "eq": [
                      "reversal",
                      "unknown"
                    ]
                  }
                ]
              },
              {
                "all": [
                  {
                    "not": {
                      "any": [
                        {
                          "eq": [
                            "payment_intent",
                            "reversed"
                          ]
                        },
                        {
                          "in": [
                            "reversal",
                            [
                              "full",
                              "dispute_lost"
                            ]
                          ]
                        }
                      ]
                    }
                  },
                  {
                    "not": {
                      "any": [
                        {
                          "eq": [
                            "payment_intent",
                            "succeeded"
                          ]
                        },
                        {
                          "eq": [
                            "session",
                            "paid"
                          ]
                        }
                      ]
                    }
                  },
                  {
                    "not": {
                      "all": [
                        {
                          "true": "terminal_charge_free_proven"
                        },
                        {
                          "eq": [
                            "marker",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "candidate",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "session",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "payment_intent",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "reversal",
                            "absent"
                          ]
                        }
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "payment_intent",
                        "unsettled"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "session",
                        "unpaid"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "candidate",
                        "unbound"
                      ]
                    }
                  },
                  {
                    "not": {
                      "eq": [
                        "marker",
                        "present"
                      ]
                    }
                  },
                  {
                    "not": {
                      "all": [
                        {
                          "not": {
                            "true": "terminal_charge_free_proven"
                          }
                        },
                        {
                          "eq": [
                            "marker",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "candidate",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "session",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "payment_intent",
                            "absent"
                          ]
                        },
                        {
                          "eq": [
                            "reversal",
                            "absent"
                          ]
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  ],
  "unknown_semantics": "explicit_complement_of_all_other_class_predicates"
}
```

</section>

<section data-registry="legacy_dispositions">

## Registry `legacy_dispositions`

```json
{
  "allowed_accounting_effects": [
    "preserve"
  ],
  "allowed_actions": [
    "close_no_provider",
    "close_charge_free",
    "resume_or_reconcile_hold",
    "paid_hold",
    "reversed_terminal",
    "quarantine"
  ],
  "entries": [
    {
      "accounting_effect": "preserve",
      "action": "close_no_provider",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "pending_no_provider",
      "provider_create_allowed": false,
      "required_proofs": [
        "drained",
        "zero_provider_identity_proven"
      ]
    },
    {
      "accounting_effect": "preserve",
      "action": "resume_or_reconcile_hold",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "marker_only",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "resume_or_reconcile_hold",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "candidate_unbound",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "resume_or_reconcile_hold",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "session_bound_unpaid",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "resume_or_reconcile_hold",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "payment_intent_unsettled",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "paid_hold",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "paid",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "reversed_terminal",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "reversed",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "close_charge_free",
      "activation_blocker": false,
      "canonical_adoption": "none",
      "class": "terminal_charge_free",
      "provider_create_allowed": false,
      "required_proofs": [
        "terminal_charge_free_proven"
      ]
    },
    {
      "accounting_effect": "preserve",
      "action": "quarantine",
      "activation_blocker": true,
      "canonical_adoption": "none",
      "class": "unknown",
      "provider_create_allowed": false,
      "required_proofs": []
    },
    {
      "accounting_effect": "preserve",
      "action": "quarantine",
      "activation_blocker": true,
      "canonical_adoption": "none",
      "class": "conflict",
      "provider_create_allowed": false,
      "required_proofs": []
    }
  ],
  "name": "legacy_dispositions"
}
```

</section>

<section data-registry="legacy_source_classes">

## Registry `legacy_source_classes`

```json
{
  "canonical_adoption_domain": [
    "none"
  ],
  "name": "legacy_source_classes",
  "source_versioned": true,
  "values": [
    "pending_no_provider",
    "marker_only",
    "candidate_unbound",
    "session_bound_unpaid",
    "payment_intent_unsettled",
    "paid",
    "reversed",
    "terminal_charge_free",
    "unknown",
    "conflict"
  ]
}
```

</section>

<section data-registry="legacy_source_facts">

## Registry `legacy_source_facts`

```json
{
  "caller_authoritative_fields": [],
  "digest_pattern": "^[0-9a-f]{64}$",
  "enums": {
    "candidate": [
      "absent",
      "unbound",
      "bound"
    ],
    "canonical_adoption": [
      "none"
    ],
    "marker": [
      "absent",
      "present"
    ],
    "payment_intent": [
      "absent",
      "unsettled",
      "succeeded",
      "failed",
      "reversed",
      "unknown"
    ],
    "reversal": [
      "absent",
      "partial",
      "full",
      "dispute_lost",
      "unknown"
    ],
    "session": [
      "absent",
      "unpaid",
      "paid",
      "unknown"
    ],
    "source_era": [
      "parent",
      "current"
    ]
  },
  "exact_fields": [
    "source_identity",
    "source_version",
    "source_digest",
    "source_era",
    "canonical_adoption",
    "marker",
    "candidate",
    "session",
    "payment_intent",
    "reversal",
    "identity_conflict",
    "mapping_conflict",
    "terminal_charge_free_proven",
    "drained",
    "zero_provider_identity_proven",
    "open_unmapped_exposure"
  ],
  "name": "legacy_source_facts",
  "strict_booleans": [
    "identity_conflict",
    "mapping_conflict",
    "terminal_charge_free_proven",
    "drained",
    "zero_provider_identity_proven",
    "open_unmapped_exposure"
  ],
  "string_bounds": {
    "source_identity": [
      1,
      256
    ],
    "source_version": [
      1,
      128
    ]
  }
}
```

</section>

<section data-registry="order_edges_with_guards">

## Registry `order_edges_with_guards`

```json
{
  "all_unlisted_rejected": true,
  "edges": [
    {
      "from": "draft",
      "guard": "tx3_first_marker",
      "to": "provisioning"
    },
    {
      "from": "draft",
      "guard": "never_entered_provider",
      "to": "abandoned"
    },
    {
      "from": "draft",
      "guard": "audited_hold",
      "to": "blocked"
    },
    {
      "from": "provisioning",
      "guard": "tx5_exact_bind",
      "to": "payable"
    },
    {
      "from": "provisioning",
      "guard": "tx7_exact_settlement",
      "to": "paid"
    },
    {
      "from": "provisioning",
      "guard": "conflict_or_failed_pi",
      "to": "ambiguous"
    },
    {
      "from": "provisioning",
      "guard": "tx13_all_generations_charge_free",
      "to": "abandoned"
    },
    {
      "from": "provisioning",
      "guard": "audited_hold",
      "to": "blocked"
    },
    {
      "from": "payable",
      "guard": "tx7_exact_settlement",
      "to": "paid"
    },
    {
      "from": "payable",
      "guard": "tx6_terminal_charge_free_rotate_fence",
      "to": "provisioning"
    },
    {
      "from": "payable",
      "guard": "conflict",
      "to": "ambiguous"
    },
    {
      "from": "payable",
      "guard": "tx13_all_generations_charge_free",
      "to": "abandoned"
    },
    {
      "from": "payable",
      "guard": "audited_hold",
      "to": "blocked"
    },
    {
      "from": "ambiguous",
      "guard": "tx7_exact_settlement",
      "to": "paid"
    },
    {
      "from": "ambiguous",
      "guard": "tx6_reconciled_rotate_fence",
      "to": "provisioning"
    },
    {
      "from": "ambiguous",
      "guard": "tx13_all_generations_charge_free",
      "to": "abandoned"
    },
    {
      "from": "ambiguous",
      "guard": "audited_hold",
      "to": "blocked"
    },
    {
      "from": "blocked",
      "guard": "audited_unblock_from_draft",
      "to": "draft"
    },
    {
      "from": "blocked",
      "guard": "audited_unblock_from_provisioning",
      "to": "provisioning"
    },
    {
      "from": "blocked",
      "guard": "audited_unblock_from_payable",
      "to": "payable"
    },
    {
      "from": "blocked",
      "guard": "audited_unblock_from_ambiguous",
      "to": "ambiguous"
    },
    {
      "from": "blocked",
      "guard": "tx7_exact_settlement_preserve_holds",
      "to": "paid"
    },
    {
      "from": "blocked",
      "guard": "tx13_plus_audited_unblock",
      "to": "abandoned"
    },
    {
      "from": "paid",
      "guard": "full_refund_or_lost_dispute",
      "to": "reversed"
    },
    {
      "from": "paid",
      "guard": "compatible_or_partial_or_dispute",
      "to": "paid"
    },
    {
      "from": "reversed",
      "guard": "compatible_later_evidence",
      "to": "reversed"
    }
  ],
  "name": "order_edges_with_guards"
}
```

</section>

<section data-registry="order_states">

## Registry `order_states`

```json
{
  "name": "order_states",
  "values": [
    "draft",
    "provisioning",
    "payable",
    "ambiguous",
    "blocked",
    "abandoned",
    "paid",
    "reversed"
  ]
}
```

</section>

<section data-registry="outage_routing">

## Registry `outage_routing`

```json
{
  "activated_requires_runtime_admission": true,
  "hold_cleanup_provider_effect_dispatch": "forbidden",
  "instance_db_failure_latches": true,
  "name": "outage_routing",
  "replacement_instance_unadmitted": true
}
```

</section>

<section data-registry="owner_kind_nullability_rules">

## Registry `owner_kind_nullability_rules`

```json
{
  "branches": {
    "global": "both_null_enumerated_entity_kind",
    "order": "scope_nonnull_order_nonnull_composite_fk",
    "order_only": "forbidden",
    "scope": "scope_nonnull_order_null_independent_scope_fk"
  },
  "name": "owner_kind_nullability_rules"
}
```

</section>

<section data-registry="payment_identity_lock_protocol">

## Registry `payment_identity_lock_protocol`

```json
{
  "alias_rule": "charge_to_payment_intent_immutable_insert_once",
  "evidence_rule": "append_only_with_separate_unique_consumption",
  "global_lock_kind": "pg_advisory_xact_lock",
  "global_lock_name": "hsb-provider-payment-identity-v1",
  "identity_order": [
    "identity_kind",
    "identity_id"
  ],
  "name": "payment_identity_lock_protocol",
  "steps": [
    "acquire_global_transaction_advisory_lock",
    "materialize_presented_identities",
    "lock_identity_rows_in_kind_id_order",
    "validate_immutable_aliases",
    "insert_alias_once_or_quarantine_repoint",
    "recompute_complete_alias_closure_post_lock",
    "read_unconsumed_reversals_across_closure",
    "lock_order_after_closure",
    "consume_and_update_atomically",
    "refuse_fulfillment_until_complete"
  ]
}
```

</section>

<section data-registry="preserved_controls">

## Registry `preserved_controls`

```json
{
  "name": "preserved_controls",
  "values": [
    "draft_fingerprint_mismatch_requires_start_new_purchase",
    "immutable_reversal_evidence_separate_unique_consumption",
    "platform_old_deployment_routing_termination_max_duration_barrier",
    "verified_drain_catch_up_item_privilege",
    "source_versioned_backfill_revisions",
    "prohibit_hold_to_shadow_and_legacy_reverse_fallback",
    "narrow_activated_to_hold_outage_function",
    "append_only_historical_resolution",
    "documentation_implementation_activation_external_authority_separated"
  ]
}
```

</section>

<section data-registry="projection_contract">

## Registry `projection_contract`

```json
{
  "apply": "sequence_monotonic_owner_token_fenced_exact_readback",
  "name": "projection_contract",
  "outbox_identity": [
    "entity_kind",
    "entity_key",
    "mutation_seq"
  ],
  "payload": "immutable_canonical_bytes_and_digest",
  "poison_blocks_activation": true,
  "reverse_gate_exists": false
}
```

</section>

<section data-registry="provider_authorization_facts">

## Registry `provider_authorization_facts`

```json
{
  "frozen_before_create": [
    "mode",
    "customer_reference_digest",
    "catalog_version",
    "sku",
    "quantity",
    "line_items_digest",
    "list_subtotal",
    "promotion_rule_version",
    "promotion_eligibility",
    "discount_bounds",
    "exact_discount",
    "exact_total",
    "currency",
    "canonical_metadata_digest",
    "idempotency_key",
    "generation",
    "fence",
    "epoch",
    "document_identity",
    "fulfillment_contract_version"
  ],
  "late_binding": "one_time_under_payment_identity_lock_conflict_never_overwrites",
  "name": "provider_authorization_facts",
  "payment_intent_initially_null": true,
  "positive_subtotal_zero": "only_exact_frozen_100_percent_promotion_and_no_payment_required"
}
```

</section>

<section data-registry="provider_phase_edges_with_guards">

## Registry `provider_phase_edges_with_guards`

```json
{
  "all_unlisted_rejected": true,
  "edges": [
    {
      "from": "absent",
      "guard": "tx3_immutable_authorization",
      "to": "marker"
    },
    {
      "from": "marker",
      "guard": "tx4_exact_response",
      "to": "candidate"
    },
    {
      "from": "marker",
      "guard": "terminal_charge_free",
      "to": "superseded"
    },
    {
      "from": "marker",
      "guard": "unknown_or_conflict",
      "to": "ambiguous"
    },
    {
      "from": "candidate",
      "guard": "tx5_exact_tuple",
      "to": "bound"
    },
    {
      "from": "candidate",
      "guard": "atomic_bind_settle",
      "to": "settled"
    },
    {
      "from": "candidate",
      "guard": "tx6_charge_free",
      "to": "superseded"
    },
    {
      "from": "candidate",
      "guard": "conflict",
      "to": "ambiguous"
    },
    {
      "from": "bound",
      "guard": "exact_settlement",
      "to": "settled"
    },
    {
      "from": "bound",
      "guard": "tx6_charge_free",
      "to": "superseded"
    },
    {
      "from": "bound",
      "guard": "contradiction",
      "to": "ambiguous"
    },
    {
      "from": "ambiguous",
      "guard": "owned_reconciliation",
      "to": "candidate"
    },
    {
      "from": "ambiguous",
      "guard": "owned_reconciliation",
      "to": "bound"
    },
    {
      "from": "ambiguous",
      "guard": "exact_authenticated_settlement",
      "to": "settled"
    },
    {
      "from": "ambiguous",
      "guard": "authoritative_charge_free",
      "to": "superseded"
    },
    {
      "from": "settled",
      "guard": "compatible_evidence",
      "to": "settled"
    },
    {
      "from": "superseded",
      "guard": "consistent_terminal_evidence",
      "to": "superseded"
    }
  ],
  "name": "provider_phase_edges_with_guards",
  "tx3_after_tx6": "validate_existing_provisioning_then_insert_marker_without_second_order_transition"
}
```

</section>

<section data-registry="provider_phases">

## Registry `provider_phases`

```json
{
  "name": "provider_phases",
  "values": [
    "absent",
    "marker",
    "candidate",
    "bound",
    "settled",
    "superseded",
    "ambiguous"
  ]
}
```

</section>

<section data-registry="roles_and_function_grants">

## Registry `roles_and_function_grants`

```json
{
  "direct_table_dml_nonowner": false,
  "drain_catch_up_item": "hsb_backfill_only_verified_active_drain_closed_admission_designated_run",
  "enter_hold_after_outage": "hsb_app_only_activated_to_hold_exact_epoch_generation",
  "name": "roles_and_function_grants",
  "public_execute": false,
  "roles": [
    "hsb_owner",
    "hsb_app",
    "hsb_webhook",
    "hsb_worker",
    "hsb_backfill",
    "hsb_stage_admin",
    "hsb_auditor"
  ]
}
```

</section>

<section data-registry="stage_edges">

## Registry `stage_edges`

```json
{
  "all_complements_rejected": true,
  "edges": [
    {
      "from": "off",
      "guard": "begin_shadow",
      "to": "shadow"
    },
    {
      "from": "shadow",
      "guard": "disable_shadow",
      "to": "off"
    },
    {
      "from": "shadow",
      "guard": "begin_backfill",
      "to": "backfill"
    },
    {
      "from": "backfill",
      "guard": "backfill_rollback",
      "to": "shadow"
    },
    {
      "from": "backfill",
      "guard": "backfill_verified",
      "to": "verified"
    },
    {
      "from": "verified",
      "guard": "verification_invalidated",
      "to": "backfill"
    },
    {
      "from": "verified",
      "guard": "verified_rollback",
      "to": "shadow"
    },
    {
      "from": "verified",
      "guard": "activation_gate_passed",
      "to": "activated"
    },
    {
      "from": "activated",
      "guard": "runtime_outage_latch",
      "to": "hold"
    },
    {
      "from": "hold",
      "guard": "audited_resume",
      "to": "activated"
    }
  ],
  "legacy_reverse_fallback_prohibited": true,
  "name": "stage_edges"
}
```

</section>

<section data-registry="stages">

## Registry `stages`

```json
{
  "name": "stages",
  "values": [
    "off",
    "shadow",
    "backfill",
    "verified",
    "activated",
    "hold"
  ]
}
```

</section>

<section data-registry="transition_guards">

## Registry `transition_guards`

```json
{
  "name": "transition_guards",
  "values": [
    "activation_gate_passed",
    "all_later_evidence",
    "atomic_bind_settle",
    "audited_hold",
    "audited_resume",
    "audited_unblock_from_ambiguous",
    "audited_unblock_from_draft",
    "audited_unblock_from_payable",
    "audited_unblock_from_provisioning",
    "authoritative_charge_free",
    "backfill_rollback",
    "backfill_verified",
    "begin_backfill",
    "begin_shadow",
    "compatible_evidence",
    "compatible_later_evidence",
    "compatible_lost_evidence",
    "compatible_open_evidence",
    "compatible_or_partial_or_dispute",
    "compatible_won_evidence",
    "conflict",
    "conflict_or_failed_pi",
    "consistent_terminal_evidence",
    "contradiction",
    "disable_shadow",
    "exact_authenticated_settlement",
    "exact_settlement",
    "first_lost_evidence",
    "first_open_evidence",
    "first_won_evidence",
    "full_refund_or_lost_dispute",
    "lost_evidence",
    "never_entered_provider",
    "opposite_lost_evidence",
    "opposite_won_evidence",
    "owned_reconciliation",
    "runtime_outage_latch",
    "stale_open_preserves_terminal",
    "terminal_charge_free",
    "tx13_all_generations_charge_free",
    "tx13_plus_audited_unblock",
    "tx3_first_marker",
    "tx3_immutable_authorization",
    "tx4_exact_response",
    "tx5_exact_bind",
    "tx5_exact_tuple",
    "tx6_charge_free",
    "tx6_reconciled_rotate_fence",
    "tx6_terminal_charge_free_rotate_fence",
    "tx7_exact_settlement",
    "tx7_exact_settlement_preserve_holds",
    "unknown_or_conflict",
    "verification_invalidated",
    "verified_rollback",
    "won_evidence"
  ]
}
```

</section>

<!-- END GENERATED REGISTRIES -->

The documentation verdict does not authorize implementation, activation, migration, database provisioning, provider/payment/refund action, customer/order access or contact, email, print, fulfillment, commit, push, PR, deployment, or production action. Provider qualification remains `HOLD_UNQUALIFIED`.
