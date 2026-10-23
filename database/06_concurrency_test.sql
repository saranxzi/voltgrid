-- ============================================================================
-- VoltGrid: Smart EV Charging & Infrastructure Management System
-- File: 06_concurrency_test.sql (Verification Harness & Race Condition Test)
-- ============================================================================

-- ============================================================================
-- TEST 1: Physical GIST Exclusion Constraint Double-Booking Guard
-- Expected Result: The second INSERT MUST fail with an exclusion violation:
-- "ERROR: conflicting key value violates exclusion constraint no_overlapping_active_reservations"
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '=== Running Test 1: Testing GIST Exclusion Constraint on Overlapping Window ===';
END $$;

-- 1.1 Insert baseline reservation for 10:00 AM to 11:00 AM tomorrow
INSERT INTO charging_reservation (
    driver_id, vehicle_id, bay_id, tariff_id, 
    start_time, end_time, initial_soc_percent, target_soc_percent, 
    energy_delivered_kwh, total_amount_due, reservation_status
) VALUES (
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    'dddddddd-dddd-dddd-dddd-ddddddddddd1',
    'ffffffff-ffff-ffff-ffff-fffffffffff1',
    '11111111-1111-1111-1111-111111111101',
    CURRENT_DATE + INTERVAL '1 day 10 hours',
    CURRENT_DATE + INTERVAL '1 day 11 hours',
    20.00, 80.00, 49.20, 17.22, 'CONFIRMED'
);

-- 1.2 Attempt conflicting overlapping insert for 10:30 AM to 11:30 AM on the SAME bay
-- Notice: This DO block catches the expected error to demonstrate constraint correctness
DO $$
BEGIN
    INSERT INTO charging_reservation (
        driver_id, vehicle_id, bay_id, tariff_id, 
        start_time, end_time, initial_soc_percent, target_soc_percent, 
        energy_delivered_kwh, total_amount_due, reservation_status
    ) VALUES (
        'cccccccc-cccc-cccc-cccc-ccccccccccc2',
        'dddddddd-dddd-dddd-dddd-ddddddddddd2',
        'ffffffff-ffff-ffff-ffff-fffffffffff1',
        '11111111-1111-1111-1111-111111111101',
        CURRENT_DATE + INTERVAL '1 day 10 hours 30 minutes',
        CURRENT_DATE + INTERVAL '1 day 11 hours 30 minutes',
        30.00, 80.00, 38.70, 13.55, 'CONFIRMED'
    );
    RAISE EXCEPTION 'TEST 1 FAILED: Overlapping reservation was erroneously permitted!';
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE NOTICE '>>> TEST 1 PASSED: GIST Exclusion Constraint successfully blocked double-booking! (SQLSTATE: %)', SQLSTATE;
END $$;


-- ============================================================================
-- TEST 2: Stored Procedure Physical Connector Compatibility Check
-- Expected Result: Trying to book a CHAdeMO-only vehicle at a bay with only 
-- CCS2/NACS connectors returns 'INCOMPATIBLE_PORT' without locking the system.
-- ============================================================================

DO $$
DECLARE
    v_res RECORD;
BEGIN
    RAISE NOTICE '=== Running Test 2: Testing Physical Connector Compatibility Guard ===';

    -- Vehicle 9 is an MG Comet EV Urban (TYPE2 connector)
    -- Bay 2 only has CCS2 connector
    SELECT * INTO v_res FROM sp_book_charging_bay_atomic(
        'cccccccc-cccc-cccc-cccc-ccccccccccc1', -- Aarav Patel
        'dddddddd-dddd-dddd-dddd-ddddddddddd9', -- MG Comet EV Urban (TYPE2)
        'ffffffff-ffff-ffff-ffff-fffffffffff2', -- Bay 2 (CCS2 only)
        '11111111-1111-1111-1111-111111111101',
        CURRENT_DATE + INTERVAL '2 days 14 hours',
        CURRENT_DATE + INTERVAL '2 days 15 hours',
        10.00, 80.00
    );

    IF v_res.status = 'INCOMPATIBLE_PORT' THEN
        RAISE NOTICE '>>> TEST 2 PASSED: Connector mismatch successfully caught: "%"', v_res.message;
    ELSE
        RAISE EXCEPTION 'TEST 2 FAILED: Expected INCOMPATIBLE_PORT but received %: %', v_res.status, v_res.message;
    END IF;
END $$;


-- ============================================================================
-- TEST 3: Stored Procedure Atomic Booking (Happy Path)
-- ============================================================================

DO $$
DECLARE
    v_res RECORD;
BEGIN
    RAISE NOTICE '=== Running Test 3: Testing sp_book_charging_bay_atomic Happy Path ===';

    SELECT * INTO v_res FROM sp_book_charging_bay_atomic(
        'cccccccc-cccc-cccc-cccc-ccccccccccc1', -- David Miller
        'dddddddd-dddd-dddd-dddd-ddddddddddd1', -- Tesla (NACS)
        'ffffffff-ffff-ffff-ffff-fffffffffff6', -- Bay 6 (Tech Plaza - has NACS)
        '11111111-1111-1111-1111-111111111102', -- Highway Plan
        CURRENT_DATE + INTERVAL '2 days 09 hours',
        CURRENT_DATE + INTERVAL '2 days 10 hours',
        20.00, 80.00
    );

    IF v_res.status = 'SUCCESS' THEN
        RAISE NOTICE '>>> TEST 3 PASSED: Reserved successfully with ID: %, Estimated Cost: $%', v_res.reservation_id, v_res.estimated_cost;
    ELSE
        RAISE EXCEPTION 'TEST 3 FAILED: Booking failed with status %: %', v_res.status, v_res.message;
    END IF;
END $$;


-- ============================================================================
-- TEST 4: Analytical Views & Window Functions Verification
-- ============================================================================

SELECT '=== Grid Feeder Hierarchy (Recursive CTE) ===' AS test_banner;
SELECT station_name, grid_tier_depth, grid_routing_lineage, max_grid_capacity_kw 
FROM v_grid_hierarchy_tree;

SELECT '=== Driver Leaderboard (Window Functions: DENSE_RANK & Percentiles) ===' AS test_banner;
SELECT driver_name, loyalty_tier, total_energy_kwh, global_energy_rank, tier_percentile_rank, platform_share_percentage
FROM v_driver_analytics_leaderboard;

SELECT '=== Materialized View Performance Summary ===' AS test_banner;
SELECT station_name, total_bays, available_bays, total_all_time_reservations, total_energy_delivered_kwh, total_revenue_generated_usd
FROM mv_station_performance_summary;
