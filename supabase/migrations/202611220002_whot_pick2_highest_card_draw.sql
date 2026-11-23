-- SquadBet Whot targeted rules patch (review before execution).
-- 1) A valid Pick 2 response cancels the existing penalty (Option A).
-- 2) Exhaustion compares each player's highest individual card; higher loses.
-- 3) Existing match/session update and settlement trigger remain in place.
-- No wallet, fee, timeout, disconnect, or settlement function is changed.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_old text;
    v_new text;
    v_count integer;
BEGIN
    -- Patch Pick 2 without replacing the rest of the live gameplay function.
    v_definition := pg_get_functiondef(
        'public.whot_apply_action(uuid,uuid,text,integer,text)'::regprocedure
    );

    v_old := 'v_pending := v_pending + 2;';
    v_new := 'v_pending := CASE WHEN v_pending > 0 THEN 0 ELSE 2 END;';
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count = 1 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF v_count <> 0 OR position(v_new IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Expected exactly one Pick Two stacking expression; found %. No patch applied.', v_count;
    END IF;

    v_old := $old$'"Pick Two: defend with another 2 or collect"'::jsonb$old$;
    v_new := $new$to_jsonb(CASE
                    WHEN v_pending = 0 THEN 'Pick Two penalty cancelled. Turn continues.'
                    ELSE 'Pick Two: defend with another 2 or collect'
                END)$new$;
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count = 1 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF v_count <> 0 OR position('Pick Two penalty cancelled. Turn continues.' IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Expected Pick Two message was not found exactly once. No patch applied.';
    END IF;
    EXECUTE v_definition;

    -- Patch exhaustion scoring. Keep the existing function body, validations,
    -- state transition, session update and settlement-trigger invocation.
    v_definition := pg_get_functiondef(
        'public.whot_resolve_exhaustion(uuid,uuid,text)'::regprocedure
    );

    v_old := 'SELECT COALESCE(SUM((card->>''value'')::bigint), 0)';
    v_new := $new$SELECT COALESCE(
        MAX(CASE WHEN (card->>'value') ~ '^-?[0-9]+$'
                 THEN (card->>'value')::bigint END),
        -1
    )$new$;
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count = 2 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF v_count <> 0 OR (
        length(v_definition) - length(replace(v_definition, v_new, ''))
    ) / length(v_new) <> 2 THEN
        RAISE EXCEPTION 'Expected exactly two hand-total aggregate expressions; found %. No patch applied.', v_count;
    END IF;

    -- Higher highest-card value loses (reverse the previous lower-total-wins comparisons).
    v_old := 'IF v_player1_total < v_player2_total THEN';
    v_new := 'IF v_player1_total > v_player2_total THEN';
    IF position(v_old IN v_definition) > 0 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF position(v_new IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Player 1 exhaustion comparison not found. No patch applied.';
    END IF;

    v_old := 'ELSIF v_player2_total < v_player1_total THEN';
    v_new := 'ELSIF v_player2_total > v_player1_total THEN';
    IF position(v_old IN v_definition) > 0 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF position(v_new IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Player 2 exhaustion comparison not found. No patch applied.';
    END IF;

    -- Higher highest-card value loses: award the win to the other player.
    v_old := 'v_winner := v_match.player1_id;';
    v_new := '__WHOT_TEMP_WINNER__';
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one Player 1 winner assignment; found %.', v_count;
    END IF;
    v_definition := replace(v_definition, v_old, v_new);

    v_old := 'v_winner := v_match.player2_id;';
    v_new := 'v_winner := v_match.player1_id;';
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Expected one Player 2 winner assignment; found %.', v_count;
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
    v_definition := replace(v_definition, '__WHOT_TEMP_WINNER__', 'v_winner := v_match.player2_id;');
    -- Persist explicit reveal fields while retaining the old score keys for compatibility.
    v_old := '    IF v_winner IS NULL THEN';
    v_new := $new$    v_state := jsonb_set(v_state, '{player1HighestCard}', to_jsonb(v_player1_total), true);
    v_state := jsonb_set(v_state, '{player2HighestCard}', to_jsonb(v_player2_total), true);

    IF v_winner IS NULL THEN$new$;
    IF position(v_old IN v_definition) > 0 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF position('{player1HighestCard}' IN v_definition) = 0 OR position('{player2HighestCard}' IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Score persistence insertion point not found. No patch applied.';
    END IF;

    v_old := 'Draw! Both players have equal card totals. Stakes refunded.';
    v_new := 'Draw! Both players revealed equal highest-numbered cards. Stakes refunded.';
    IF position(v_old IN v_definition) > 0 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF position(v_new IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Exhaustion draw message not found. No patch applied.';
    END IF;

    v_old := 'Cards exhausted! Lowest card total wins.';
    v_new := 'Cards exhausted! The player with the lower highest-numbered card wins.';
    IF position(v_old IN v_definition) > 0 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF position(v_new IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Exhaustion winner message not found. No patch applied.';
    END IF;

    -- Add reveal values to the RPC response consumed by the action route.
    v_old := '        ''player2Score'', v_player2_total,';
    v_new := $new$        'player2Score', v_player2_total,
        'player1HighestCard', v_player1_total,
        'player2HighestCard', v_player2_total,$new$;
    IF position(v_old IN v_definition) > 0 THEN
        v_definition := replace(v_definition, v_old, v_new);
    ELSIF position('player1HighestCard' IN v_definition) = 0 OR position('player2HighestCard' IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Exhaustion RPC return block not found. No patch applied.';
    END IF;

    EXECUTE v_definition;
END;
$migration$;

COMMIT;
