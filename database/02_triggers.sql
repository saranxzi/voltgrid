-- ============================================================================
-- VoltGrid: Smart EV Charging & Infrastructure Management System
-- File: 02_triggers.sql (Automated Database Triggers & Business Integrity)
-- ============================================================================

-- ============================================================================
-- TRIGGER 1: Synchronize Bay Status on Maintenance Tickets & Reservations
-- Purpose: Ensures physical bay state reflects active repairs and charging.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_sync_bay_status_from_ticket()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
        -- If ticket is newly opened or in progress, take the bay offline for maintenance
        IF NEW.ticket_status IN ('OPEN', 'IN_PROGRESS') THEN
            UPDATE charging_bay
            SET bay_status = 'MAINTENANCE'
            WHERE bay_id = NEW.bay_id;
        -- If ticket was resolved or closed, restore bay to AVAILABLE (unless other open tickets exist)
        ELSIF NEW.ticket_status IN ('RESOLVED', 'CLOSED') THEN
            IF NOT EXISTS (
                SELECT 1 FROM maintenance_ticket 
                WHERE bay_id = NEW.bay_id 
                  AND ticket_status IN ('OPEN', 'IN_PROGRESS')
                  AND ticket_id <> NEW.ticket_id
            ) THEN
                UPDATE charging_bay
                SET bay_status = 'AVAILABLE'
                WHERE bay_id = NEW.bay_id AND bay_status = 'MAINTENANCE';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_bay_status_ticket ON maintenance_ticket;
CREATE TRIGGER trg_sync_bay_status_ticket
AFTER INSERT OR UPDATE OF ticket_status ON maintenance_ticket
FOR EACH ROW
EXECUTE FUNCTION fn_sync_bay_status_from_ticket();


-- ============================================================================
-- TRIGGER 2: Telemetry Audit & Aggregation Trigger
-- Purpose: Automatically writes an immutable JSONB telemetry snapshot on 
--          reservation state transitions (CONFIRMED -> ACTIVE -> COMPLETED).
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_audit_reservation_telemetry()
RETURNS TRIGGER AS $$
DECLARE
    v_station_id UUID;
    v_driver_email VARCHAR(255);
    v_vehicle_plate VARCHAR(20);
    v_tariff_name VARCHAR(100);
BEGIN
    -- Fetch contextual metadata for snapshot
    SELECT cb.station_id INTO v_station_id
    FROM charging_bay cb
    WHERE cb.bay_id = NEW.bay_id;

    SELECT ua.email INTO v_driver_email
    FROM user_account ua
    WHERE ua.account_id = NEW.driver_id;

    SELECT ev.license_plate INTO v_vehicle_plate
    FROM ev_vehicle ev
    WHERE ev.vehicle_id = NEW.vehicle_id;

    SELECT tp.plan_name INTO v_tariff_name
    FROM tariff_plan tp
    WHERE tp.tariff_id = NEW.tariff_id;

    -- Synchronize Bay Status if reservation goes active or ends
    IF NEW.reservation_status = 'ACTIVE' THEN
        UPDATE charging_bay SET bay_status = 'OCCUPIED' WHERE bay_id = NEW.bay_id;
    ELSIF NEW.reservation_status IN ('COMPLETED', 'CANCELLED') THEN
        UPDATE charging_bay SET bay_status = 'AVAILABLE' 
        WHERE bay_id = NEW.bay_id AND bay_status IN ('OCCUPIED', 'RESERVED');
    END IF;

    -- Record Audit Telemetry Event
    INSERT INTO audit_station_telemetry_log (
        station_id,
        bay_id,
        reservation_id,
        event_type,
        metric_snapshot,
        created_at
    ) VALUES (
        v_station_id,
        NEW.bay_id,
        NEW.reservation_id,
        'RESERVATION_' || NEW.reservation_status::text,
        jsonb_build_object(
            'driver_email', v_driver_email,
            'license_plate', v_vehicle_plate,
            'tariff_plan', v_tariff_name,
            'start_time', NEW.start_time,
            'end_time', NEW.end_time,
            'duration_minutes', ROUND(EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60, 2),
            'initial_soc', NEW.initial_soc_percent,
            'target_soc', NEW.target_soc_percent,
            'energy_delivered_kwh', NEW.energy_delivered_kwh,
            'total_amount_due', NEW.total_amount_due,
            'status_transition', CASE 
                WHEN TG_OP = 'INSERT' THEN 'CREATED'
                ELSE OLD.reservation_status::text || ' -> ' || NEW.reservation_status::text
            END
        ),
        CURRENT_TIMESTAMP
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_reservation_lifecycle ON charging_reservation;
CREATE TRIGGER trg_audit_reservation_lifecycle
AFTER INSERT OR UPDATE OF reservation_status, energy_delivered_kwh, total_amount_due ON charging_reservation
FOR EACH ROW
EXECUTE FUNCTION fn_audit_reservation_telemetry();


-- ============================================================================
-- TRIGGER 3: Automated Account Updated-At Timestamp Maintenance
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_account_touch ON user_account;
CREATE TRIGGER trg_user_account_touch
BEFORE UPDATE ON user_account
FOR EACH ROW
EXECUTE FUNCTION fn_touch_updated_at();
