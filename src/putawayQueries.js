const esc = s => String(s).replace(/'/g, "''")

export const FIELD_LABELS = {
  lodnum: 'LPN',
  wh_id: 'Warehouse',
  cur_bldg_id: 'Building',
  sto_config_id: 'Search path ID',
  sto_zone_cod: 'Storage zone',
}

function missingComment(id, missingKeys) {
  const labels = missingKeys.map(k => FIELD_LABELS[k]).join(', ')
  return `/* Step ${id} needs: ${labels}\n   Fill in the missing field(s) above. */`
}

const PART_LOOKUP = `[select distinct d.prtnum,
        d.prt_client_id,
        p.velzon as part_velocity
   from invlod il
   join invsub s on s.lodnum = il.lodnum
   join invdtl d on d.subnum = s.subnum
   left join prtmst_view p
     on p.prtnum        = d.prtnum
    and p.prt_client_id = d.prt_client_id
    and p.wh_id         = il.wh_id
  where il.lodnum = @lodnum
    and il.wh_id  = @wh_id]`

function lpnPublish(f) {
  return `publish data\n where wh_id  = '${esc(f.wh_id)}'\n   and lodnum = '${esc(f.lodnum)}'`
}

export const PUTAWAY_STEPS = [
  /* ------------------------------------------------------------------ */
  {
    id: '1A',
    group: 'Gate 1 – LPN & part',
    label: 'LPN check',
    needs: ['lodnum', 'wh_id'],
    hint: 'Checks whether the LPN exists in the warehouse, has inventory, is a single-part pallet, and has no pending move already.\n\nlpn_check:\n  OK                               → continue to 1B\n  LPN NOT FOUND IN THIS WAREHOUSE  → wrong LPN or warehouse\n  LPN HAS NO INVENTORY DETAILS     → receipt not completed\n  MIXED LPN - MORE THAN ONE PART   → each part must fit the same search path; run 1B per part\n  ALREADY ALLOCATED - PENDING MOVE → putaway already has a destination; see R2\n\nfailed_before = 1 means a previous allocation already returned error 11125.',
    build: (f) => `/* ----------------------------------------------------------------------
   1A - LPN CHECK
   Always returns one row.
   lpn_check:
     OK                                   -> continue to 1B
     LPN NOT FOUND IN THIS WAREHOUSE      -> wrong LPN or warehouse
     LPN HAS NO INVENTORY DETAILS         -> receipt not completed
     MIXED LPN - MORE THAN ONE PART       -> each part must fit the same
                                             search path; check 1B per part
     ALREADY ALLOCATED - PENDING MOVE     -> putaway already has a
                                             destination; see R2
   failed_before = 1 -> a previous allocation already failed (11125).
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
[select x.lodnum,
        x.wh_id,
        x.current_location,
        x.failed_before,
        x.part_count,
        x.pending_moves,
        case when x.lpn_found = 0     then 'LPN NOT FOUND IN THIS WAREHOUSE'
             when x.part_count = 0    then 'LPN HAS NO INVENTORY DETAILS'
             when x.part_count > 1    then 'MIXED LPN - MORE THAN ONE PART'
             when x.pending_moves > 0 then 'ALREADY ALLOCATED - PENDING MOVE'
             else 'OK'
        end as lpn_check
   from (select @lodnum as lodnum,
                @wh_id  as wh_id,
                case when il.lodnum is null then 0 else 1 end as lpn_found,
                il.stoloc         as current_location,
                il.no_loc_putaway as failed_before,
                (select count(distinct d.prtnum)
                   from invsub s
                   join invdtl d on d.subnum = s.subnum
                  where s.lodnum = @lodnum) as part_count,
                (select count(*)
                   from invmov m
                  where m.lodnum = @lodnum) as pending_moves
           from (select 1 as n) d0
           left join invlod il
             on il.lodnum = @lodnum
            and il.wh_id  = @wh_id) x]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: '1B',
    group: 'Gate 1 – LPN & part',
    label: 'Part check',
    needs: ['lodnum', 'wh_id'],
    hint: 'Checks the part setup in the warehouse. Returns one row per part on the LPN.\n\npart_check:\n  OK                                → continue to Gate 2\n  PART NOT SET UP IN THIS WAREHOUSE → part missing for the warehouse\n  MISSING DEPARTMENT                → search paths by department cannot match\n  MISSING ITEM FAMILY               → no family, so no family group\n  FAMILY HAS NO GROUP               → item family not mapped to a group\n  MISSING VELOCITY                  → fails zone rules with Match Velocity = Yes\n  NO FOOTPRINT IN THIS WAREHOUSE    → capacity cannot be calculated\n\nNote department, item_family_group and velocity for Gate 2.',
    build: (f) => `/* ----------------------------------------------------------------------
   1B - PART CHECK (one row per part on the LPN)
   Checks the part setup in THIS warehouse.
   part_check:
     OK                                -> continue to GATE 2
     PART NOT SET UP IN THIS WAREHOUSE -> part missing for the warehouse
     MISSING DEPARTMENT                -> search paths by department
                                          cannot match
     MISSING ITEM FAMILY               -> no family, so no family group
     FAMILY HAS NO GROUP               -> item family not mapped to a group
     MISSING VELOCITY                  -> fails zone rules with
                                          Match Velocity = Yes
     NO FOOTPRINT IN THIS WAREHOUSE    -> capacity cannot be calculated
   Note department, item_family_group and velocity for the next gates.
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
[select y.prtnum,
        y.prt_client_id,
        y.inventory_status,
        y.department,
        y.item_family,
        y.item_family_group,
        y.velocity,
        y.footprint_rows,
        case when y.part_found = 0                     then 'PART NOT SET UP IN THIS WAREHOUSE'
             when y.department is null
               or y.department = ''                    then 'MISSING DEPARTMENT'
             when y.item_family is null
               or y.item_family = ''                   then 'MISSING ITEM FAMILY'
             when y.item_family_group is null
               or y.item_family_group = ''             then 'FAMILY HAS NO GROUP'
             when y.velocity is null
               or y.velocity = ''                      then 'MISSING VELOCITY'
             when y.footprint_rows = 0                 then 'NO FOOTPRINT IN THIS WAREHOUSE'
             else 'OK'
        end as part_check
   from (select distinct
                d.prtnum,
                d.prt_client_id,
                d.invsts     as inventory_status,
                case when p.prtnum is null then 0 else 1 end as part_found,
                p.dept_cod   as department,
                p.prtfam     as item_family,
                pf.prtfamgrp as item_family_group,
                p.velzon     as velocity,
                (select count(*)
                   from prtftp_dtl f
                  where f.prtnum        = d.prtnum
                    and f.prt_client_id = d.prt_client_id
                    and f.wh_id         = il.wh_id) as footprint_rows
           from invlod il
           join invsub s on s.lodnum = il.lodnum
           join invdtl d on d.subnum = s.subnum
           left join prtmst_view p
             on p.prtnum        = d.prtnum
            and p.prt_client_id = d.prt_client_id
            and p.wh_id         = il.wh_id
           left join prtfam pf on pf.prtfam = p.prtfam
          where il.lodnum = @lodnum
            and il.wh_id  = @wh_id) y]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: '2A',
    group: 'Gate 2 – Search path',
    label: 'Matching search paths',
    needs: ['lodnum', 'wh_id'],
    hint: 'Compares the LPN against every search path in the warehouse. Shows full matches and near-misses (1 field different).\n\nmatch_result:\n  MATCH                        → all criteria match; the system uses this path\n  MATCH - NO CRITERIA          → catch-all path, matches everything\n  POSSIBLE - CHECK 2B          → matches, but has criteria fields not checked automatically; verify in 2B\n  NO MATCH - n FIELD(S) DIFFER → near miss; run 2B to see which field\n\nNo rows at all = no search path is even close → the path for this part is missing, or the part data from 1B is wrong.\nSeveral matches: the system uses the one with the best PRIORITY (check the Storage Search Paths screen).',
    build: (f) => `/* ----------------------------------------------------------------------
   2A - WHICH SEARCH PATHS MATCH THIS LPN
   Compares the LPN against the criteria of every search path in the
   warehouse. Shows full matches and near misses (1 field different).
   Fields compared automatically:
     dept_cod, prtfamgrp, prtfam, prtnum, invsts, velzon,
     mov_zone_id (movement zone of the LPN's current location)
   Any other criteria field is counted as "unchecked" -> verify in 2B.
   match_result:
     MATCH                       -> all criteria match
     MATCH - NO CRITERIA         -> catch-all path, matches everything
     POSSIBLE - CHECK 2B         -> matches, but has unchecked fields
     NO MATCH - n FIELD(S) DIFFER-> near miss; 2B shows which field
   No rows at all = no search path is even close -> the search path for
   this part is missing, or the part data (1B) is wrong.
   Several matches: the system uses the one with the best PRIORITY
   (check priority on the Storage Search Paths screen).
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
[select m.search_path,
        m.criteria_fields,
        m.matched_fields,
        m.unchecked_fields,
        m.criteria_fields - m.matched_fields - m.unchecked_fields as fields_differ,
        case when m.matched_fields = m.criteria_fields
             then 'MATCH'
             when m.matched_fields + m.unchecked_fields = m.criteria_fields
             then 'POSSIBLE - CHECK 2B'
             else 'NO MATCH - '
                  + cast(m.criteria_fields - m.matched_fields - m.unchecked_fields as varchar(5))
                  + ' FIELD(S) DIFFER'
        end as match_result
   from (select c.sto_config_id as search_path,
                count(distinct c.colnam) as criteria_fields,
                count(distinct case when a.colval is not null
                                    then c.colnam end) as matched_fields,
                count(distinct case when c.colnam not in ('dept_cod','prtfamgrp','prtfam',
                                                          'prtnum','invsts','velzon',
                                                          'mov_zone_id')
                                    then c.colnam end) as unchecked_fields
           from sto_config_criteria c
           join sto_config sc
             on sc.sto_config_id = c.sto_config_id
           left join (select k.colnam,
                             case k.colnam
                                  when 'dept_cod'    then lp.dept_cod
                                  when 'prtfamgrp'   then lp.prtfamgrp
                                  when 'prtfam'      then lp.prtfam
                                  when 'prtnum'      then lp.prtnum
                                  when 'invsts'      then lp.invsts
                                  when 'velzon'      then lp.velzon
                                  when 'mov_zone_id' then lp.mov_zone_id
                             end as colval
                        from (select distinct
                                     d.prtnum,
                                     d.invsts,
                                     p.dept_cod,
                                     p.prtfam,
                                     pf.prtfamgrp,
                                     p.velzon,
                                     cast(lm.mov_zone_id as varchar(20)) as mov_zone_id
                                from invlod il
                                join invsub s on s.lodnum = il.lodnum
                                join invdtl d on d.subnum = s.subnum
                                left join prtmst_view p
                                  on p.prtnum        = d.prtnum
                                 and p.prt_client_id = d.prt_client_id
                                 and p.wh_id         = il.wh_id
                                left join prtfam pf on pf.prtfam = p.prtfam
                                left join locmst lm
                                  on lm.stoloc = il.stoloc
                                 and lm.wh_id  = il.wh_id
                               where il.lodnum = @lodnum
                                 and il.wh_id  = @wh_id) lp
                       cross join (select 'dept_cod' as colnam
                                   union all select 'prtfamgrp'
                                   union all select 'prtfam'
                                   union all select 'prtnum'
                                   union all select 'invsts'
                                   union all select 'velzon'
                                   union all select 'mov_zone_id') k) a
             on a.colnam = c.colnam
            and a.colval = c.colval
          where sc.wh_id = @wh_id
          group by c.sto_config_id) m
  where m.criteria_fields - m.matched_fields - m.unchecked_fields <= 1
 union all
 select sc.sto_config_id as search_path,
        0 as criteria_fields,
        0 as matched_fields,
        0 as unchecked_fields,
        0 as fields_differ,
        'MATCH - NO CRITERIA' as match_result
   from sto_config sc
  where sc.wh_id = @wh_id
    and not exists (select 1
                      from sto_config_criteria c
                     where c.sto_config_id = sc.sto_config_id)
  order by fields_differ, search_path]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: '2B',
    group: 'Gate 2 – Search path',
    label: 'Criteria detail',
    needs: ['lodnum', 'wh_id', 'sto_config_id'],
    hint: 'Shows each criteria row of one search path next to the LPN\'s actual value.\n\ncriteria_result:\n  MATCH                         → this value matches\n  DIFFERS                       → LPN value is different; this is what blocks the path\n  NOT CHECKED - VERIFY MANUALLY → field not compared automatically; compare on the search path screen\n\nA field with several rows (multiple allowed values) matches when at least ONE row says MATCH.\nGet the search path ID from step 2A.',
    build: (f) => `/* ----------------------------------------------------------------------
   2B - CRITERIA DETAIL FOR ONE SEARCH PATH
   Each criteria row of the path next to the LPN's value.
   criteria_result:
     MATCH                        -> this value matches
     DIFFERS                      -> LPN value is different
     NOT CHECKED - VERIFY MANUALLY-> field not compared automatically;
                                     compare on the search path screen
   A field with several rows (several allowed values) matches when at
   least ONE of its rows says MATCH.
   ---------------------------------------------------------------------- */
publish data
 where wh_id         = '${esc(f.wh_id)}'
   and lodnum        = '${esc(f.lodnum)}'
   and sto_config_id = '${esc(f.sto_config_id)}'
|
[select c.sto_config_id as search_path,
        c.colnam        as criteria_field,
        c.colval        as criteria_value,
        a.colval        as lpn_value,
        case when c.colnam not in ('dept_cod','prtfamgrp','prtfam',
                                   'prtnum','invsts','velzon','mov_zone_id')
             then 'NOT CHECKED - VERIFY MANUALLY'
             when a.colval = c.colval
             then 'MATCH'
             else 'DIFFERS'
        end as criteria_result
   from sto_config_criteria c
   left join (select k.colnam,
                     case k.colnam
                          when 'dept_cod'    then lp.dept_cod
                          when 'prtfamgrp'   then lp.prtfamgrp
                          when 'prtfam'      then lp.prtfam
                          when 'prtnum'      then lp.prtnum
                          when 'invsts'      then lp.invsts
                          when 'velzon'      then lp.velzon
                          when 'mov_zone_id' then lp.mov_zone_id
                     end as colval
                from (select distinct
                             d.prtnum,
                             d.invsts,
                             p.dept_cod,
                             p.prtfam,
                             pf.prtfamgrp,
                             p.velzon,
                             cast(lm.mov_zone_id as varchar(20)) as mov_zone_id
                        from invlod il
                        join invsub s on s.lodnum = il.lodnum
                        join invdtl d on d.subnum = s.subnum
                        left join prtmst_view p
                          on p.prtnum        = d.prtnum
                         and p.prt_client_id = d.prt_client_id
                         and p.wh_id         = il.wh_id
                        left join prtfam pf on pf.prtfam = p.prtfam
                        left join locmst lm
                          on lm.stoloc = il.stoloc
                         and lm.wh_id  = il.wh_id
                       where il.lodnum = @lodnum
                         and il.wh_id  = @wh_id) lp
               cross join (select 'dept_cod' as colnam
                           union all select 'prtfamgrp'
                           union all select 'prtfam'
                           union all select 'prtnum'
                           union all select 'invsts'
                           union all select 'velzon'
                           union all select 'mov_zone_id') k) a
     on a.colnam = c.colnam
  where c.sto_config_id = @sto_config_id
  order by c.colnam, c.colval]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: '2C',
    group: 'Gate 2 – Search path',
    label: 'Zone rules',
    needs: ['sto_config_id', 'cur_bldg_id'],
    hint: 'Shows where the matched search path tells the system to look, in rule order.\n\nbuilding_check:\n  OK                          → rule is in the LPN\'s building; putaway will try it\n  DIFFERENT BUILDING THAN LPN → rule will not be used for this LPN\n\nNo rows = the search path has no zone rules → add rules to the path.\ncur_bldg_id comes from the "allocate location" trace arguments.',
    build: (f) => `/* ----------------------------------------------------------------------
   2C - ZONE RULES OF THE SEARCH PATH
   Where the matched path tells the system to look, in rule order.
   building_check:
     OK                          -> rule is in the LPN's building
     DIFFERENT BUILDING THAN LPN -> rule will not be used for this LPN
   No rows = the search path has no zone rules -> add rules.
   cur_bldg_id = value from the "allocate location" trace arguments.
   ---------------------------------------------------------------------- */
publish data
 where sto_config_id = '${esc(f.sto_config_id)}'
   and cur_bldg_id   = '${esc(f.cur_bldg_id)}'
|
[select r.sto_config_id      as search_path,
        r.sto_config_rule_id as rule_id,
        z.bldg_id            as building,
        z.sto_zone_cod       as storage_zone,
        r.strategy,
        case when z.bldg_id = @cur_bldg_id then 'OK'
             else 'DIFFERENT BUILDING THAN LPN'
        end as building_check
   from sto_config_rule r
   join sto_zone z on z.sto_zone_id = r.sto_zone_id
  where r.sto_config_id = @sto_config_id
  order by r.sto_config_rule_id]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: '3A',
    group: 'Gate 3 – Locations',
    label: 'Zone capacity',
    needs: ['lodnum', 'wh_id', 'sto_config_id'],
    hint: 'Shows capacity for every zone in the search path at once. Part, client and velocity are read from the LPN. A mixed LPN returns one result set per part.\n\nzone_check:\n  OK                                   → rule can place the LPN\n  NO PARTIAL OF THIS PART - NORMAL     → expected on first receipt; the next rule is tried\n  NO AVAILABLE EMPTY LOCATION          → zone is full or blocked; run 3B for the reason\n  ZONE HAS NO LOCATIONS IN WAREHOUSE   → no locations assigned to this zone\n  REVIEW - OTHER STRATEGY              → strategy is not partial/empty; review the rule\n\nIf NO rule says OK, this is why error 11125 happens.',
    build: (f) => `/* ----------------------------------------------------------------------
   3A - CAPACITY OF EVERY ZONE IN THE SEARCH PATH
   One row per zone rule, all zones of the path at once.
   prtnum / prt_client_id = the LPN's part (from 1B), used to find
   partial locations that already hold the same part.
   zone_check:
     OK                                   -> rule can place the LPN
     NO PARTIAL OF THIS PART - NORMAL     -> expected on first receipt;
                                             the next rule is tried
     NO AVAILABLE EMPTY LOCATION          -> zone is full / blocked;
                                             go to 3B for the reason
     ZONE HAS NO LOCATIONS IN WAREHOUSE   -> no locations assigned to zone
     REVIEW - OTHER STRATEGY              -> strategy not partial/empty;
                                             review the rule
   If NO rule says OK -> this is why 11125 happens.
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
${PART_LOOKUP}
|
publish data
 where wh_id         = '${esc(f.wh_id)}'
   and sto_config_id = '${esc(f.sto_config_id)}'
|
[select g.rule_id,
        g.building,
        g.storage_zone,
        g.strategy,
        g.total_locations,
        g.available_empty,
        g.same_part_with_room,
        g.empty_but_reserved,
        g.partially_full,
        g.full_locations,
        g.blocked_inventory_error,
        g.other_status,
        g.disabled_or_not_storable,
        case when g.total_locations = 0
             then 'ZONE HAS NO LOCATIONS IN WAREHOUSE'
             when g.strategy like 'PARTIAL%' and g.same_part_with_room = 0
             then 'NO PARTIAL OF THIS PART - NORMAL'
             when g.strategy like 'EMPT%' and g.available_empty = 0
             then 'NO AVAILABLE EMPTY LOCATION'
             when g.strategy not like 'PARTIAL%' and g.strategy not like 'EMPT%'
             then 'REVIEW - OTHER STRATEGY'
             else 'OK'
        end as zone_check
   from (select r.sto_config_rule_id as rule_id,
                z.bldg_id            as building,
                z.sto_zone_cod       as storage_zone,
                r.strategy,
                count(l.stoloc) as total_locations,
                sum(case when l.locsts = 'E' and l.curqvl = 0 and l.pndqvl = 0
                          and l.useflg = 1 and l.stoflg = 1
                         then 1 else 0 end) as available_empty,
                sum(case when l.locsts = 'P' and sp.stoloc is not null
                          and l.curqvl + l.pndqvl < l.maxqvl
                          and l.useflg = 1 and l.stoflg = 1
                         then 1 else 0 end) as same_part_with_room,
                sum(case when l.locsts = 'E' and l.pndqvl > 0
                         then 1 else 0 end) as empty_but_reserved,
                sum(case when l.locsts = 'P' then 1 else 0 end) as partially_full,
                sum(case when l.locsts = 'F' then 1 else 0 end) as full_locations,
                sum(case when l.locsts = 'I' then 1 else 0 end) as blocked_inventory_error,
                sum(case when l.locsts not in ('E','P','F','I')
                         then 1 else 0 end) as other_status,
                sum(case when l.useflg = 0 or l.stoflg = 0
                         then 1 else 0 end) as disabled_or_not_storable
           from sto_config_rule r
           join sto_zone z on z.sto_zone_id = r.sto_zone_id
           left join locmst l
             on l.sto_zone_id = r.sto_zone_id
            and l.wh_id       = @wh_id
           left join (select distinct il.wh_id, il.stoloc
                        from invlod il
                        join invsub s on s.lodnum = il.lodnum
                        join invdtl d on d.subnum = s.subnum
                       where d.prtnum        = @prtnum
                         and d.prt_client_id = @prt_client_id) sp
             on sp.wh_id  = l.wh_id
            and sp.stoloc = l.stoloc
          where r.sto_config_id = @sto_config_id
          group by r.sto_config_rule_id, z.bldg_id, z.sto_zone_cod, r.strategy) g
  order by g.rule_id]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: '3B',
    group: 'Gate 3 – Locations',
    label: 'Location detail',
    needs: ['lodnum', 'wh_id', 'sto_zone_cod'],
    hint: 'Run for a zone that step 3A flagged. Shows every location in the zone with its reason. Part, client and velocity are read from the LPN. A mixed LPN returns one result set per part.\n\nputaway_check:\n  ELIGIBLE - EMPTY             → can be used\n  ELIGIBLE - SAME PART PARTIAL → can be used by the partial rule\n  RESERVED BY PENDING MOVE     → empty, but another LPN is going there\n  PARTIAL - OTHER PART OR FULL → holds other stock or has no room\n  FULL                         → no room\n  BLOCKED - INVENTORY ERROR    → status I, skipped by putaway\n  LOCKED / PENDING             → status L / N\n  DISABLED / NOT STORABLE      → location off or Storable = No\n  VELOCITY DIFFERS             → fails if Match Velocity = Yes on the zone rule\n\nLocation dimensions are shown to compare with the footprint (step O5).',
    build: (f) => `/* ----------------------------------------------------------------------
   3B - LOCATION DETAIL FOR ONE ZONE
   Run for a zone that 3A flagged. Every location with its reason.
   part_velocity = velocity from 1B.
   putaway_check:
     ELIGIBLE - EMPTY             -> can be used
     ELIGIBLE - SAME PART PARTIAL -> can be used by the partial rule
     RESERVED BY PENDING MOVE     -> empty, but another LPN is going there
     PARTIAL - OTHER PART OR FULL -> holds other stock or has no room
     FULL                         -> no room
     BLOCKED - INVENTORY ERROR    -> status I, skipped by putaway
     LOCKED / PENDING             -> status L / N
     DISABLED / NOT STORABLE      -> location off / Storable = No
     VELOCITY DIFFERS             -> fails if Match Velocity = Yes
   Location dimensions are shown to compare with the footprint (O5).
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
${PART_LOOKUP}
|
publish data
 where wh_id        = '${esc(f.wh_id)}'
   and sto_zone_cod = '${esc(f.sto_zone_cod)}'
|
[select l.stoloc        as location,
        z.bldg_id       as building,
        z.sto_zone_cod  as storage_zone,
        mz.mov_zone_cod as movement_zone,
        pz.pck_zone_cod as pick_zone,
        lt.loc_typ      as location_type,
        lt.loc_typ_cat  as location_category,
        l.velzon        as location_velocity,
        l.locsts        as location_status,
        l.curqvl        as current_qty,
        l.pndqvl        as pending_qty,
        l.maxqvl        as max_qty,
        l.loclen        as location_length,
        l.locwid        as location_width,
        l.lochgt        as location_height,
        case when l.useflg = 0               then 'DISABLED'
             when l.stoflg = 0               then 'NOT STORABLE'
             when l.locsts = 'I'             then 'BLOCKED - INVENTORY ERROR'
             when l.locsts = 'L'             then 'LOCKED'
             when l.locsts = 'N'             then 'PENDING'
             when l.locsts = 'F'             then 'FULL'
             when l.locsts = 'E'
              and l.pndqvl > 0               then 'RESERVED BY PENDING MOVE'
             when l.velzon <> @part_velocity then 'VELOCITY DIFFERS'
             when l.locsts = 'P'
              and sp.stoloc is not null
              and l.curqvl + l.pndqvl < l.maxqvl
                                             then 'ELIGIBLE - SAME PART PARTIAL'
             when l.locsts = 'P'             then 'PARTIAL - OTHER PART OR FULL'
             when l.locsts = 'E'             then 'ELIGIBLE - EMPTY'
             else 'CHECK'
        end as putaway_check
   from locmst l
   join sto_zone z       on z.sto_zone_id  = l.sto_zone_id
   left join mov_zone mz on mz.mov_zone_id = l.mov_zone_id
   left join pck_zone pz on pz.pck_zone_id = l.pck_zone_id
   left join loc_typ lt  on lt.loc_typ_id  = l.loc_typ_id
   left join (select distinct il.wh_id, il.stoloc
                from invlod il
                join invsub s on s.lodnum = il.lodnum
                join invdtl d on d.subnum = s.subnum
               where d.prtnum        = @prtnum
                 and d.prt_client_id = @prt_client_id) sp
     on sp.wh_id  = l.wh_id
    and sp.stoloc = l.stoloc
  where l.wh_id = @wh_id
    and z.sto_zone_cod = @sto_zone_cod
  order by putaway_check, l.stoloc]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: 'O1',
    group: 'Optional',
    label: 'Zone rule settings',
    needs: ['sto_config_id'],
    hint: 'All columns of the search path\'s rules. Look for limits that are not zero (zone/aisle inventory minimum/maximum, utilization percentage) and flags (last location, mixed location, match velocity).\n\nA non-zero maximum that is already reached blocks the zone even when it has empty locations. Compare with the Storage Zone Rules screen.',
    build: (f) => `/* ----------------------------------------------------------------------
   O1 - FULL ZONE RULE SETTINGS
   All columns of the path's rules. Look for limits that are not zero
   (zone / aisle inventory minimum / maximum, utilization percentage)
   and flags (last location, mixed location, match velocity).
   A non-zero maximum that is already reached blocks the zone even when
   it has empty locations. Compare with the Storage Zone Rules screen.
   ---------------------------------------------------------------------- */
publish data
 where sto_config_id = '${esc(f.sto_config_id)}'
|
[select *
   from sto_config_rule
  where sto_config_id = @sto_config_id
  order by sto_config_rule_id]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: 'O2',
    group: 'Optional',
    label: 'Mixing rules',
    needs: ['lodnum', 'wh_id', 'sto_zone_cod'],
    hint: 'Runs the same mixing-rules check the allocation engine runs ("check inventory mixing rules for storage zone"). An error result here means the zone\'s mixing rules reject this LPN, even if the zone has eligible locations.\n\nGet the storage zone code from step 2C.',
    build: (f) => `/* ----------------------------------------------------------------------
   O2 - MIXING RULES FOR THE ZONE
   Runs the same check the allocation runs ("check inventory mixing
   rules for storage zone"). An error here means the zone's mixing
   rules reject this LPN.
   ---------------------------------------------------------------------- */
publish data
 where wh_id        = '${esc(f.wh_id)}'
   and lodnum       = '${esc(f.lodnum)}'
   and sto_zone_cod = '${esc(f.sto_zone_cod)}'
|
[select sto_zone_id
   from sto_zone
  where sto_zone_cod = @sto_zone_cod]
|
check inventory mixing rules for storage zone
 where lodnum      = @lodnum
   and sto_zone_id = @sto_zone_id
   and wh_id       = @wh_id`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: 'O3',
    group: 'Optional',
    label: 'ALLOCATE-LOC policies',
    needs: ['wh_id'],
    hint: 'Lists warehouse policies that change how locations are chosen (e.g. USE-EACH-HEIGHT, ORDER-BY, RESPECT-FIFO-SKIP-LOCS). Compare with a warehouse where putaway works to spot differences.',
    build: (f) => `/* ----------------------------------------------------------------------
   O3 - ALLOCATE-LOC POLICIES
   Warehouse policies that change how locations are chosen
   (e.g. USE-EACH-HEIGHT, ORDER-BY, RESPECT-FIFO-SKIP-LOCS).
   Compare with a warehouse where putaway works.
   ---------------------------------------------------------------------- */
publish data
 where wh_id = '${esc(f.wh_id)}'
|
[select polcod, polvar, polval, srtseq, rtstr1, rtstr2, rtnum1
   from poldat_view
  where polcod = 'ALLOCATE-LOC'
    and wh_id  = @wh_id
  order by polvar, polval, srtseq]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: 'O4',
    group: 'Optional',
    label: 'Part across warehouses',
    needs: ['lodnum', 'wh_id'],
    hint: 'Shows the part setup in every warehouse and the template (----). Differences are not errors by themselves (a warehouse can use its own departments on purpose), but they explain why a part works in one warehouse and not in another.\n\nPart, client and velocity are read from the LPN. A mixed LPN returns one result set per part.',
    build: (f) => `/* ----------------------------------------------------------------------
   O4 - SAME PART ACROSS WAREHOUSES
   Part setup in every warehouse and the template (----).
   Differences are not errors by themselves (a warehouse can use its
   own departments on purpose), but they explain why a part works in
   one warehouse and not in another.
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
${PART_LOOKUP}
|
[select p.wh_id_tmpl as warehouse,
        p.prtnum,
        p.dept_cod   as department,
        p.prtfam     as item_family,
        pf.prtfamgrp as item_family_group,
        p.velzon     as velocity,
        p.rcvsts     as receive_status
   from prtmst p
   left join prtfam pf on pf.prtfam = p.prtfam
  where p.prtnum        = @prtnum
    and p.prt_client_id = @prt_client_id
  order by p.wh_id_tmpl]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: 'O5',
    group: 'Optional',
    label: 'Footprint',
    needs: ['lodnum', 'wh_id'],
    hint: 'Units of measure and dimensions of the part in the warehouse. Compare the pallet level with the location dimensions shown in step 3B.\n\nVery small values (e.g. 0.01) are placeholders: they always fit but do not reflect the real pallet.\n\nPart, client and velocity are read from the LPN. A mixed LPN returns one result set per part.',
    build: (f) => `/* ----------------------------------------------------------------------
   O5 - FOOTPRINT DETAIL
   Units of measure and dimensions of the part in the warehouse.
   Compare the pallet level with the location dimensions in 3B.
   Very small values (e.g. 0.01) are placeholders: they always fit,
   but do not reflect the real pallet.
   ---------------------------------------------------------------------- */
${lpnPublish(f)}
|
${PART_LOOKUP}
|
publish data
 where wh_id = '${esc(f.wh_id)}'
|
[select d.wh_id,
        d.prtnum,
        d.ftpcod as footprint,
        d.uomcod as unit_of_measure,
        d.untqty as units_per_uom,
        d.len    as length,
        d.wid    as width,
        d.hgt    as height,
        d.grswgt as gross_weight
   from prtftp_dtl d
  where d.wh_id         = @wh_id
    and d.prtnum        = @prtnum
    and d.prt_client_id = @prt_client_id
  order by d.ftpcod, d.untqty]`,
  },
  /* ------------------------------------------------------------------ */
  {
    id: 'R2',
    group: 'Result',
    label: 'Allocation result',
    needs: ['lodnum'],
    hint: 'Checks the invmov table for a pending move on this LPN.\n\nA row with a destination location = putaway works.\nNo row = still failing; go back to Step 0 with a new trace.',
    build: (f) => `/* ----------------------------------------------------------------------
   R2 - CHECK THE ALLOCATION RESULT
   A row with a destination location = putaway works.
   No row = still failing; go back to Step 0 with a new trace.
   ---------------------------------------------------------------------- */
publish data
 where lodnum = '${esc(f.lodnum)}'
|
[select *
   from invmov
  where lodnum = @lodnum]`,
  },
]

const FULL_HEADER = `/* ======================================================================
   PUTAWAY TROUBLESHOOTING - Storage Search Path diagnostics
   ----------------------------------------------------------------------
   HOW TO USE
     - Run one block at a time (select the block, then execute).
     - Edit the values in each "publish data" before running.
     - Every gate query returns a *_check / *_result column:
         OK            -> move to the next gate
         anything else -> that is the issue to fix
     - Queries are built to return a row with a reason even when data
       is missing, instead of returning nothing.

   CHAIN BEING CHECKED
     LPN / Part  ->  Search Path  ->  Zone Rules  ->  Storage Zone  ->  Location

   ----------------------------------------------------------------------
   STEP 0 - READ THE TRACE FIRST (tells you where to start)
   ----------------------------------------------------------------------
   Inputs to copy from the trace ("allocate location" arguments):
     lodnum, wh_id, cur_bldg_id, invmov_typ

   Node in the trace returning -1403 / error     Start at
   ------------------------------------------    --------------------
   list inventory storage configuration prefs    GATE 1, then GATE 2
   (no search path matched)
   list partial locations for storage            normal if no stock of
                                                 the same part; continue
   list empty locations for storage              GATE 3
   get storage building sequences                info only: no overflow
                                                 to another building
   ERR 11125 No suitable location found          final result; run all
                                                 gates in order
   RF ERR 2005 Missing Destination Location      side effect of 11125;
                                                 fix the allocation first

   GATES
     GATE 1  LPN and part        1A LPN check, 1B part check
     GATE 2  Search path         2A which paths match, 2B criteria detail,
                                 2C zone rules
     GATE 3  Locations           3A all zones of the path, 3B location detail
     OPTIONAL (only when all gates say OK and putaway still fails)
             O1 zone rule settings, O2 mixing rules, O3 ALLOCATE-LOC
             policies, O4 part across warehouses, O5 footprint detail
     RETEST  R1 allocate location (commented out), R2 check result
   ====================================================================== */`

const R1_BLOCK = `/* ----------------------------------------------------------------------
   R1 - RETEST ALLOCATION  (COMMENTED OUT ON PURPOSE)
   This creates a real allocation. Run it only after fixing the issue.
   Use the same arguments as the failing trace, then check with R2.
   ---------------------------------------------------------------------- */
/*
allocate location
 where lodnum      = 'PLC2000000003NE'
   and wh_id       = 'U10'
   and cur_bldg_id = 'B1'
   and invmov_typ  = 'RCV'
*/`

export const FULL_HINT = `Read the trace first (Step 0) to find where the allocation failed, then run the gates in order.

Node in trace returning error   Start at
-------------------------------  --------------------
list inventory storage config   GATE 1, then GATE 2
list partial locations          normal if no same-part stock; continue
list empty locations            GATE 3
get storage building sequences  info only (no overflow to other building)
ERR 11125 No location found     run all gates in order
RF ERR 2005 Missing Destination side effect of 11125; fix allocation first

GATES: 1A → 1B → 2A → 2B → 2C → 3A → 3B
OPTIONAL (only if all gates OK): O1 → O2 → O3 → O4 → O5
RETEST: R2 to confirm fix worked`

export function buildPutawayOutput(fields, mode) {
  if (mode === 'FULL') {
    const parts = [FULL_HEADER]
    for (const step of PUTAWAY_STEPS) {
      const missing = step.needs.filter(k => !fields[k]?.trim())
      if (missing.length) {
        parts.push(missingComment(step.id, missing))
      } else {
        parts.push(step.build(fields))
      }
      parts.push(';')
    }
    parts.push(R1_BLOCK)
    parts.push(';')
    return parts.join('\n\n')
  }

  const step = PUTAWAY_STEPS.find(s => s.id === mode)
  if (!step) return ''
  const missing = step.needs.filter(k => !fields[k]?.trim())
  if (missing.length) return missingComment(step.id, missing)
  return step.build(fields)
}
