SQUADBET WHOT TESTING BUILD

Changes in this build:
1. Whot page now reads the nested `result.game` payload rather than treating the API wrapper as game state.
2. Whot GET API includes both players' disconnect timestamps and player IDs needed by the UI.
3. Added a visible opponent-disconnection countdown based on the server-recorded disconnect timestamp.
4. Preserved the rest of the existing SquadBet files and assets.

IMPORTANT TESTING LIMITATION:
This ZIP updates the application/API layer only. It does not change the SQL functions already installed in Supabase.
The following must be verified/installed in Supabase before declaring Whot end-to-end ready:
- whot_set_ready
- whot_apply_action
- whot_market_draw
- process_whot_timeouts
- the Whot settlement/refund function and its trigger
The countdown is a display of the server timestamp; the database timeout job remains authoritative for awarding/refunding a match.
Do not test with real stakes until the SQL functions and both-player settlement have been verified.
