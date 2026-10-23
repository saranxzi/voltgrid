-- ============================================================================
-- VoltGrid: Smart EV Charging & Infrastructure Management System
-- File: 03_stored_procedures.sql (Concurrency Control & Transaction Management)
-- ============================================================================

-- ============================================================================
-- PROCEDURE 1: sp_book_charging_bay_atomic
-- Purpose: High-concurrency atomic booking using Pessimistic Locking 
--          (SELECT ... FOR UPDATE) and explicit lock timeout guards.
-- ============================================================================

CREATE OR REPLACE FUNCTION sp_book_charging_bay_atomic(
    p_driver_id UUID,
    p_vehicle_id UUID,
    p_bay_id UUID,
    p_tariff_id UUID,
    p_start_time TIMESTAMPTZ,
    p_end_time TIMESTAMPTZ,
    p_initial_soc NUMERIC DEFAULT 20.00,
    p_target_soc NUMERIC DEFAULT 80.00
)
RETURNS TABLE (
    reservation_id UUID,
    status VARCHAR,
    message VARCHAR,
    estimated_cost NUMERIC
) AS $$
DECLARE
    v_bay_record RECORD;
    v_vehicle_connector connector_type_enum;
    v_vehicle_battery_cap NUMERIC;
    v_has_compatible_port BOOLEAN;
    v_base_rate NUMERIC;
    v_peak_multiplier NUMERIC;
    v_energy_needed_kwh NUMERIC;
    v_calc_cost NUMERIC;
    v_new_reservation_id UUID;
BEGIN
    -- Guard 1: Set localized lock timeout to fail fast under extreme contention
    SET LOCAL lock_timeout = '3s';

    -- Guard 2: Parameter validation
    IF p_end_time <= p_start_time THEN
        RETURN QUERY SELECT NULL::UUID, 'ERROR'::VARCHAR, 'End time must be strictly after start time'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    IF p_target_soc <= p_initial_soc THEN
        RETURN QUERY SELECT NULL::UUID, 'ERROR'::VARCHAR, 'Target SoC must be greater than initial SoC'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    -- Step 1: Pessimistic Row Lock on Target Bay
    BEGIN
        SELECT cb.bay_id, cb.station_id, cb.bay_status
        INTO v_bay_record
        FROM charging_bay cb
        WHERE cb.bay_id = p_bay_id
        FOR UPDATE; -- Locks the bay row against simultaneous booking workflows
    EXCEPTION 
        WHEN lock_not_available THEN
            RETURN QUERY SELECT NULL::UUID, 'LOCKED'::VARCHAR, 'Bay is currently locked by another concurrent transaction. Please retry.'::VARCHAR, 0.00::NUMERIC;
            RETURN;
    END;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, 'ERROR'::VARCHAR, 'Target charging bay does not exist'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    IF v_bay_record.bay_status IN ('MAINTENANCE', 'OFFLINE') THEN
        RETURN QUERY SELECT NULL::UUID, 'UNAVAILABLE'::VARCHAR, 'Charging bay is offline or undergoing maintenance'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    -- Step 2: Enforce Physical Connector Compatibility (Vehicle <-> Bay Port)
    SELECT ev.connector_type, ev.battery_capacity_kwh
    INTO v_vehicle_connector, v_vehicle_battery_cap
    FROM ev_vehicle ev
    WHERE ev.vehicle_id = p_vehicle_id AND ev.driver_id = p_driver_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, 'ERROR'::VARCHAR, 'Vehicle not found or does not belong to the requesting driver'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM connector_port cp
        WHERE cp.bay_id = p_bay_id
          AND cp.connector_type = v_vehicle_connector
          AND cp.port_status = 'FUNCTIONAL'
    ) INTO v_has_compatible_port;

    IF NOT v_has_compatible_port THEN
        RETURN QUERY SELECT NULL::UUID, 'INCOMPATIBLE_PORT'::VARCHAR, 
            'Target bay does not offer a functional ' || v_vehicle_connector::text || ' connector'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    -- Step 3: Check Temporal Overlap on Target Bay
    IF EXISTS (
        SELECT 1 FROM charging_reservation cr
        WHERE cr.bay_id = p_bay_id
          AND cr.reservation_status IN ('CONFIRMED', 'ACTIVE')
          AND tstzrange(cr.start_time, cr.end_time) && tstzrange(p_start_time, p_end_time)
    ) THEN
        RETURN QUERY SELECT NULL::UUID, 'OVERLAP_CONFLICT'::VARCHAR, 'Bay already has an active reservation during this time slot'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    -- Step 4: Calculate Estimated Cost based on Tariff
    SELECT tp.base_price_per_kwh, tp.peak_multiplier
    INTO v_base_rate, v_peak_multiplier
    FROM tariff_plan tp
    WHERE tp.tariff_id = p_tariff_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, 'ERROR'::VARCHAR, 'Specified tariff plan does not exist'::VARCHAR, 0.00::NUMERIC;
        RETURN;
    END IF;

    v_energy_needed_kwh := ROUND(v_vehicle_battery_cap * ((p_target_soc - p_initial_soc) / 100.0), 3);
    v_calc_cost := ROUND(v_energy_needed_kwh * v_base_rate * v_peak_multiplier, 2);

    -- Step 5: Insert Confirmed Reservation tuple
    INSERT INTO charging_reservation (
        driver_id,
        vehicle_id,
        bay_id,
        tariff_id,
        start_time,
        end_time,
        initial_soc_percent,
        target_soc_percent,
        energy_delivered_kwh,
        total_amount_due,
        reservation_status
    ) VALUES (
        p_driver_id,
        p_vehicle_id,
        p_bay_id,
        p_tariff_id,
        p_start_time,
        p_end_time,
        p_initial_soc,
        p_target_soc,
        v_energy_needed_kwh,
        v_calc_cost,
        'CONFIRMED'
    )
    RETURNING charging_reservation.reservation_id INTO v_new_reservation_id;

    -- Return Success Tuple
    RETURN QUERY SELECT 
        v_new_reservation_id, 
        'SUCCESS'::VARCHAR, 
        'Charging bay reserved successfully'::VARCHAR, 
        v_calc_cost;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- PROCEDURE 2: sp_cancel_reservation_atomic
-- Purpose: Safely cancels a confirmed reservation and frees up the slot.
-- ============================================================================

CREATE OR REPLACE FUNCTION sp_cancel_reservation_atomic(
    p_reservation_id UUID,
    p_driver_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    message VARCHAR
) AS $$
DECLARE
    v_current_status reservation_status_enum;
BEGIN
    SELECT cr.reservation_status
    INTO v_current_status
    FROM charging_reservation cr
    WHERE cr.reservation_id = p_reservation_id
      AND cr.driver_id = p_driver_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Reservation not found or does not belong to caller'::VARCHAR;
        RETURN;
    END IF;

    IF v_current_status <> 'CONFIRMED' THEN
        RETURN QUERY SELECT FALSE, ('Cannot cancel a reservation in status ' || v_current_status::text)::VARCHAR;
        RETURN;
    END IF;

    UPDATE charging_reservation
    SET reservation_status = 'CANCELLED'
    WHERE reservation_id = p_reservation_id;

    RETURN QUERY SELECT TRUE, 'Reservation cancelled successfully'::VARCHAR;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- PROCEDURE 3: sp_complete_charging_session
-- Purpose: Finalizes an active charging session with actual meter kWh.
-- ============================================================================

CREATE OR REPLACE FUNCTION sp_complete_charging_session(
    p_reservation_id UUID,
    p_actual_energy_kwh NUMERIC
)
RETURNS TABLE (
    success BOOLEAN,
    final_amount NUMERIC,
    message VARCHAR
) AS $$
DECLARE
    v_tariff_id UUID;
    v_current_status reservation_status_enum;
    v_base_price NUMERIC;
    v_peak_mult NUMERIC;
    v_final_cost NUMERIC;
BEGIN
    IF p_actual_energy_kwh <= 0 THEN
        RETURN QUERY SELECT FALSE, 0.00::NUMERIC, 'Delivered energy must be greater than zero'::VARCHAR;
        RETURN;
    END IF;

    SELECT tariff_id, reservation_status INTO v_tariff_id, v_current_status
    FROM charging_reservation
    WHERE reservation_id = p_reservation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0.00::NUMERIC, 'Reservation not found'::VARCHAR;
        RETURN;
    END IF;

    IF v_current_status NOT IN ('CONFIRMED', 'ACTIVE') THEN
        RETURN QUERY SELECT FALSE, 0.00::NUMERIC, ('Cannot complete a reservation in status ' || v_current_status::text)::VARCHAR;
        RETURN;
    END IF;

    SELECT base_price_per_kwh, peak_multiplier
    INTO v_base_price, v_peak_mult
    FROM tariff_plan
    WHERE tariff_id = v_tariff_id;

    v_final_cost := ROUND(p_actual_energy_kwh * v_base_price * v_peak_mult, 2);

    UPDATE charging_reservation
    SET reservation_status = 'COMPLETED',
        energy_delivered_kwh = p_actual_energy_kwh,
        total_amount_due = v_final_cost
    WHERE reservation_id = p_reservation_id;

    RETURN QUERY SELECT TRUE, v_final_cost, 'Charging session successfully finalized'::VARCHAR;
END;
$$ LANGUAGE plpgsql;
