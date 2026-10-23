-- ============================================================================
-- VoltGrid: Smart EV Charging & Infrastructure Management System
-- File: 04_analytical_queries.sql (Recursive CTEs, Window Functions & Materialized Views)
-- ============================================================================

-- ============================================================================
-- 1. RECURSIVE CTE: Power Grid Feeder Hierarchy & Downstream Node Traversal
-- Purpose: Recursively traces the electrical grid tree from master feeder 
--          substations down to downstream child charging stations, calculating
--          the path lineage and aggregated grid capacity at each tier.
-- ============================================================================

CREATE OR REPLACE VIEW v_grid_hierarchy_tree AS
WITH RECURSIVE GridFeederHierarchy AS (
    -- Anchor Member: Root grid hub nodes (stations without a parent)
    SELECT 
        cs.station_id,
        cs.station_name,
        cs.parent_grid_node_id,
        cs.city,
        cs.max_grid_capacity_kw,
        1 AS grid_tier_depth,
        ARRAY[cs.station_name::text] AS feeder_path,
        cs.station_name::text AS root_feeder_name
    FROM charging_station cs
    WHERE cs.parent_grid_node_id IS NULL

    UNION ALL

    -- Recursive Member: Traverse downstream substation/station children
    SELECT 
        child.station_id,
        child.station_name,
        child.parent_grid_node_id,
        child.city,
        child.max_grid_capacity_kw,
        parent.grid_tier_depth + 1 AS grid_tier_depth,
        parent.feeder_path || child.station_name::text AS feeder_path,
        parent.root_feeder_name
    FROM charging_station child
    INNER JOIN GridFeederHierarchy parent ON child.parent_grid_node_id = parent.station_id
)
SELECT 
    station_id,
    station_name,
    parent_grid_node_id,
    city,
    max_grid_capacity_kw,
    grid_tier_depth,
    array_to_string(feeder_path, ' -> ') AS grid_routing_lineage,
    root_feeder_name
FROM GridFeederHierarchy
ORDER BY root_feeder_name, grid_tier_depth, station_name;


-- ============================================================================
-- 2. ADVANCED ANALYTICAL WINDOW FUNCTIONS
-- ============================================================================

-- 2.1 Driver Consumption Leaderboard with Tier Percentile Ranking
-- Uses: DENSE_RANK(), PERCENT_RANK(), and windowed SUM/AVG partitions.
CREATE OR REPLACE VIEW v_driver_analytics_leaderboard AS
SELECT 
    ua.account_id AS driver_id,
    ua.first_name || ' ' || ua.last_name AS driver_name,
    ua.email,
    dp.loyalty_tier,
    COUNT(cr.reservation_id) AS total_sessions_completed,
    COALESCE(SUM(cr.energy_delivered_kwh), 0.00) AS total_energy_kwh,
    COALESCE(SUM(cr.total_amount_due), 0.00) AS total_spend_usd,
    
    -- Global rank based on total energy consumed
    DENSE_RANK() OVER (
        ORDER BY COALESCE(SUM(cr.energy_delivered_kwh), 0.00) DESC
    ) AS global_energy_rank,
    
    -- Percentile rank within the same driver loyalty tier
    ROUND(
        (PERCENT_RANK() OVER (
            PARTITION BY dp.loyalty_tier 
            ORDER BY COALESCE(SUM(cr.energy_delivered_kwh), 0.00) ASC
        ) * 100)::numeric, 2
    ) AS tier_percentile_rank,

    -- Rolling contribution percentage to total platform energy
    ROUND(
        (COALESCE(SUM(cr.energy_delivered_kwh), 0.00) / 
         NULLIF(SUM(SUM(cr.energy_delivered_kwh)) OVER (), 0) * 100)::numeric, 2
    ) AS platform_share_percentage

FROM driver_profile dp
JOIN user_account ua ON dp.account_id = ua.account_id
LEFT JOIN charging_reservation cr ON dp.account_id = cr.driver_id AND cr.reservation_status = 'COMPLETED'
GROUP BY ua.account_id, ua.first_name, ua.last_name, ua.email, dp.loyalty_tier;


-- 2.2 Station Hourly Throughput Trends (Rolling Averages & Velocity via LAG)
CREATE OR REPLACE VIEW v_station_utilization_trends AS
WITH StationHourlyAggregates AS (
    SELECT 
        cs.station_id,
        cs.station_name,
        date_trunc('hour', cr.start_time) AS session_hour,
        COUNT(cr.reservation_id) AS session_count,
        SUM(cr.energy_delivered_kwh) AS hourly_energy_kwh,
        SUM(cr.total_amount_due) AS hourly_revenue_usd
    FROM charging_station cs
    JOIN charging_bay cb ON cs.station_id = cb.station_id
    JOIN charging_reservation cr ON cb.bay_id = cr.bay_id
    WHERE cr.reservation_status IN ('COMPLETED', 'ACTIVE')
    GROUP BY cs.station_id, cs.station_name, date_trunc('hour', cr.start_time)
)
SELECT 
    station_id,
    station_name,
    session_hour,
    session_count,
    hourly_energy_kwh,
    hourly_revenue_usd,
    
    -- LAG function: Compare with previous hour's session volume
    LAG(session_count, 1, 0) OVER (
        PARTITION BY station_id ORDER BY session_hour
    ) AS prev_hour_sessions,
    
    -- Session Growth Delta
    session_count - LAG(session_count, 1, 0) OVER (
        PARTITION BY station_id ORDER BY session_hour
    ) AS hourly_session_growth,
    
    -- Rolling 3-Hour Moving Average of Energy Delivery
    ROUND(
        AVG(hourly_energy_kwh) OVER (
            PARTITION BY station_id 
            ORDER BY session_hour 
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        )::numeric, 2
    ) AS rolling_3hr_avg_kwh

FROM StationHourlyAggregates
ORDER BY station_name, session_hour DESC;


-- ============================================================================
-- 3. MATERIALIZED VIEW: Hourly Station Performance Summary (Fast OLAP Rollup)
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS mv_station_performance_summary;

CREATE MATERIALIZED VIEW mv_station_performance_summary AS
WITH BayStats AS (
    SELECT 
        station_id,
        COUNT(DISTINCT bay_id) AS total_bays,
        COUNT(DISTINCT CASE WHEN bay_status = 'AVAILABLE' THEN bay_id END) AS available_bays,
        COUNT(DISTINCT CASE WHEN bay_status = 'MAINTENANCE' THEN bay_id END) AS maintenance_bays
    FROM charging_bay
    GROUP BY station_id
),
ReservationStats AS (
    SELECT 
        cb.station_id,
        COUNT(DISTINCT cr.reservation_id) AS total_all_time_reservations,
        COALESCE(SUM(CASE WHEN cr.reservation_status = 'COMPLETED' THEN cr.energy_delivered_kwh ELSE 0 END), 0.00) AS total_energy_delivered_kwh,
        COALESCE(SUM(CASE WHEN cr.reservation_status = 'COMPLETED' THEN cr.total_amount_due ELSE 0 END), 0.00) AS total_revenue_generated_usd
    FROM charging_bay cb
    JOIN charging_reservation cr ON cb.bay_id = cr.bay_id
    GROUP BY cb.station_id
),
TicketStats AS (
    SELECT 
        cb.station_id,
        COUNT(DISTINCT mt.ticket_id) AS total_incidents_logged,
        COUNT(DISTINCT CASE WHEN mt.ticket_status IN ('OPEN', 'IN_PROGRESS') THEN mt.ticket_id END) AS active_open_tickets
    FROM charging_bay cb
    JOIN maintenance_ticket mt ON cb.bay_id = mt.bay_id
    GROUP BY cb.station_id
)
SELECT 
    cs.station_id,
    cs.station_name,
    cs.city,
    cs.max_grid_capacity_kw,
    COALESCE(bs.total_bays, 0) AS total_bays,
    COALESCE(bs.available_bays, 0) AS available_bays,
    COALESCE(bs.maintenance_bays, 0) AS maintenance_bays,
    
    -- Aggregated metrics over all reservations (isolated from ticket cardinality)
    COALESCE(rs.total_all_time_reservations, 0) AS total_all_time_reservations,
    COALESCE(rs.total_energy_delivered_kwh, 0.00) AS total_energy_delivered_kwh,
    COALESCE(rs.total_revenue_generated_usd, 0.00) AS total_revenue_generated_usd,
    
    -- Incident metrics
    COALESCE(ts.total_incidents_logged, 0) AS total_incidents_logged,
    COALESCE(ts.active_open_tickets, 0) AS active_open_tickets,
    
    CURRENT_TIMESTAMP AS last_refreshed_at
FROM charging_station cs
LEFT JOIN BayStats bs ON cs.station_id = bs.station_id
LEFT JOIN ReservationStats rs ON cs.station_id = rs.station_id
LEFT JOIN TicketStats ts ON cs.station_id = ts.station_id;

-- Unique Index required to enable REFRESH MATERIALIZED VIEW CONCURRENTLY (Zero-Downtime Refresh)
CREATE UNIQUE INDEX uq_mv_station_perf_id ON mv_station_performance_summary(station_id);

-- Helper procedure to refresh materialized view safely without read locking
CREATE OR REPLACE PROCEDURE sp_refresh_station_performance_view()
LANGUAGE plpgsql
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_station_performance_summary;
END;
$$;
