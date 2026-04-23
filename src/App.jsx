import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function parseSingleColumn(text) {
  return text.split(/[\r\n\t,;]+/).map(i => i.trim()).filter(Boolean)
}

function parseLocationPairs(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(/[\t,;]+|\s{2,}/).map(p => p.trim()).filter(Boolean)
    if (parts.length >= 2) return { stoloc: parts[0], locvrc: parts[1], raw: line, valid: true }
    const fb = line.split(/\s+/).map(p => p.trim()).filter(Boolean)
    if (fb.length >= 2) return { stoloc: fb[0], locvrc: fb[1], raw: line, valid: true }
    return { stoloc: '', locvrc: '', raw: line, valid: false }
  })
}

function escapeSql(value) { return String(value).replace(/'/g, "''") }

function buildWhereClause(values, columnName, alias = '') {
  if (!values.length) return ''
  const q = alias ? `${alias}.${columnName}` : columnName
  if (values.length === 1) return `where ${q} = '${escapeSql(values[0])}'`
  return `where ${q} in (${values.map(v => `'${escapeSql(v)}'`).join(', ')})`
}

function buildPrtnumOutput(items, mode) {
  if (!items.length) return ''
  if (mode === 'plain') return items.join(',')
  if (mode === 'quoted-lines') return items.map(item => `'${escapeSql(item)}',`).join('\n')
  if (mode === 'prtmst-query') {
    return `[select prtnum,\n        prtfam\n   from prtmst\n  where prtnum in (${items.map(item => `'${escapeSql(item)}'`).join(', ')})]`
  }
  if (mode === 'prtmst-useful') {
    return `[select prtnum,\n        prtfam,\n        dsp_prtnum,\n        stkuom,\n        lodlvl,\n        ser_lvl,\n        ser_typ\n   from prtmst_view\n  where prtnum in (${items.map(item => `'${escapeSql(item)}'`).join(', ')})]`
  }
  return items.map(item => `'${escapeSql(item)}'`).join(',')
}

function buildLocmstOutput(validPairs, locations, mode) {
  if (mode === 'pairs-only') {
    if (!validPairs.length) return ''
    return validPairs.map(({ stoloc, locvrc }) => `(stoloc = '${escapeSql(stoloc)}' and locvrc = '${escapeSql(locvrc)}')`)
      .join('\n or ')
  }
  if (mode === 'locations-only') {
    if (!locations.length) return ''
    return `[select stoloc,\n        locvrc\n   from locmst\n  ${buildWhereClause(locations, 'stoloc')}]`
  }
  if (mode === 'confirm-match') {
    if (!validPairs.length) return ''
    const expectedRows = validPairs.map(({ stoloc, locvrc }, i) => {
      const sel = i === 0 ? 'select' : 'union all\n select'
      return `${sel} '${escapeSql(stoloc)}' as expected_stoloc, '${escapeSql(locvrc)}' as expected_locvrc\n  from dual`
    }).join('\n ')
    return `[select exp.expected_stoloc as stoloc,\n        exp.expected_locvrc,\n        loc.locvrc as db_locvrc,\n        case\n          when loc.stoloc is null then 'NOT FOUND'\n          when loc.locvrc = exp.expected_locvrc then 'MATCH'\n          else 'MISMATCH'\n        end as match_status\n   from (${expectedRows}) exp\n   left join locmst loc\n     on loc.stoloc = exp.expected_stoloc]`
  }
  if (mode === 'operational-check') {
    if (!locations.length) return ''
    return `[select stoloc,\n        wh_id,\n        locsts,\n        useflg,\n        stoflg,\n        pckflg,\n        rescod\n   from locmst\n  ${buildWhereClause(locations, 'stoloc')}]`
  }
  if (mode === 'capacity-check') {
    if (!locations.length) return ''
    return `[select stoloc,\n        lochgt,\n        loclen,\n        locwid,\n        maxqvl,\n        curqvl\n   from locmst\n  ${buildWhereClause(locations, 'stoloc')}]`
  }
  if (mode === 'strategy-friendly') {
    if (!locations.length) return ''
    return `[select l.stoloc,\n        l.velzon as velocity_zone,\n        l.pck_zone_id,\n        pck_zone.pck_zone_cod as pck_zone,\n        l.sto_zone_id,\n        sto_zone.sto_zone_cod as sto_zone,\n        l.mov_zone_id,\n        mov_zone.mov_zone_cod as mov_zone,\n        l.loc_typ_id,\n        loc_typ.loc_typ as loc_type,\n        loc_typ.loc_typ_cat as loc_type_category\n   from locmst l\n   left join pck_zone\n     on l.pck_zone_id = pck_zone.pck_zone_id\n   left join sto_zone\n     on l.sto_zone_id = sto_zone.sto_zone_id\n   left join mov_zone\n     on l.mov_zone_id = mov_zone.mov_zone_id\n   left join loc_typ\n     on l.loc_typ_id = loc_typ.loc_typ_id\n  ${buildWhereClause(locations, 'stoloc', 'l')}]`
  }
  if (!validPairs.length) return ''
  return `[select stoloc,\n        locvrc\n   from locmst\n  where ${validPairs
    .map(({ stoloc, locvrc }, i) => `${i === 0 ? '' : '     or '}(stoloc = '${escapeSql(stoloc)}' and locvrc = '${escapeSql(locvrc)}')`)
    .join('\n')}]`
}

function buildReceivingOutput(values, mode) {
  if (!values.length) return ''
  const byRdck = mode.includes('rdck')
  const filterExpr = byRdck ? 'upper(t.yard_loc)' : 't.trlr_num'
  const fmtVal = v => byRdck ? escapeSql(v.toUpperCase()) : escapeSql(v)
  const filter = values.length === 1
    ? `${filterExpr} = '${fmtVal(values[0])}'`
    : `${filterExpr} in (${values.map(v => `'${fmtVal(v)}'`).join(', ')})`

  const fromClause = `from trlr t\n   join rcvtrk r\n     on t.trlr_id = r.trlr_id\n   join rcvlin rl\n     on r.trknum = rl.trknum\n    and r.wh_id = rl.wh_id`
  const whereClause = `where r.wh_id = 'Y10'\n    and ${filter}`

  if (mode.includes('line-detail')) {
    return `[select t.trlr_id,\n        t.trlr_num,\n        t.yard_loc,\n        t.trlr_stat,\n        r.trknum,\n        rl.prtnum,\n        rl.invnum,\n        rl.rcvkey,\n        rl.rcvsts,\n        rl.rcvqty,\n        rcvinv.invtyp\n   ${fromClause}\n   left join rcvinv\n     on rl.invnum = rcvinv.invnum\n    and rl.trknum = rcvinv.trknum\n    and rl.wh_id = rcvinv.wh_id\n  ${whereClause}]`
  }
  if (mode.includes('inventory-split')) {
    return `[select t.trlr_id,\n        t.trlr_num,\n        t.yard_loc,\n        t.trlr_stat,\n        r.trknum,\n        rl.prtnum,\n        rl.invnum,\n        rl.rcvkey,\n        inventory_view.lodnum as lpn,\n        inventory_view.stoloc as inventory_location,\n        inventory_view.invsts,\n        inventory_view.untqty\n   ${fromClause}\n   left join inventory_view\n     on inventory_view.rcvkey = rl.rcvkey\n  ${whereClause}]`
  }
  if (mode.includes('summary')) {
    return `[select t.trlr_id,\n        t.trlr_num,\n        t.yard_loc,\n        t.trlr_stat,\n        r.trknum,\n        rl.prtnum,\n        rl.invnum,\n        rl.rcvkey,\n        rl.rcvsts,\n        rl.rcvqty,\n        rcvinv.invtyp,\n        count(distinct inventory_view.lodnum) as lpn_count,\n        sum(inventory_view.untqty) as inventory_qty\n   ${fromClause}\n   left join rcvinv\n     on rl.invnum = rcvinv.invnum\n    and rl.trknum = rcvinv.trknum\n    and rl.wh_id = rcvinv.wh_id\n   left join inventory_view\n     on inventory_view.rcvkey = rl.rcvkey\n  ${whereClause}\n  group by t.trlr_id,\n           t.trlr_num,\n           t.yard_loc,\n           t.trlr_stat,\n           r.trknum,\n           rl.prtnum,\n           rl.invnum,\n           rl.rcvkey,\n           rl.rcvsts,\n           rl.rcvqty,\n           rcvinv.invtyp]`
  }
  return `[select t.trlr_id,\n        t.trlr_num,\n        t.yard_loc,\n        t.trlr_stat,\n        r.trknum,\n        rl.prtnum,\n        rl.invnum,\n        rl.rcvkey,\n        rl.rcvsts,\n        rl.rcvqty,\n        rcvinv.invtyp,\n        inventory_view.lodnum as lpn,\n        inventory_view.stoloc as inventory_location,\n        inventory_view.invsts,\n        inventory_view.untqty\n   ${fromClause}\n   left join rcvinv\n     on rl.invnum = rcvinv.invnum\n    and rl.trknum = rcvinv.trknum\n    and rl.wh_id = rcvinv.wh_id\n   left join inventory_view\n     on inventory_view.rcvkey = rl.rcvkey\n  ${whereClause}]`
}

function buildShippingOutput(values, mode) {
  if (!values.length) return ''
  const byTrailer = mode.includes('trailer')
  const filterExpr = byTrailer ? 'trlr.trlr_num' : 'shipment.ship_id'
  const filter = values.length === 1
    ? `${filterExpr} = '${escapeSql(values[0])}'`
    : `${filterExpr} in (${values.map(v => `'${escapeSql(v)}'`).join(', ')})`

  const baseFrom = `from trlr trlr\n   join car_move car_move\n     on trlr.trlr_id = car_move.trlr_id\n   join stop stop\n     on car_move.stop_id = stop.stop_id\n    and car_move.wh_id = stop.wh_id\n   join shipment shipment\n     on stop.stop_id = shipment.stop_id\n    and stop.wh_id = shipment.wh_id`
  const baseWhere = `where shipment.wh_id = 'Y10'\n    and ${filter}`

  if (mode.includes('header')) {
    return `[select distinct trlr.trlr_id,\n        trlr.trlr_num,\n        trlr.yard_loc,\n        trlr.trlr_stat,\n        car_move.carcod,\n        stop.stop_id,\n        shipment.ship_id,\n        shipment.shpsts\n   ${baseFrom}\n  ${baseWhere}]`
  }
  if (mode.includes('line-detail')) {
    return `[select trlr.trlr_id,\n        trlr.trlr_num,\n        trlr.yard_loc,\n        trlr.trlr_stat,\n        car_move.carcod,\n        stop.stop_id,\n        shipment.ship_id,\n        shipment.shpsts,\n        shipment_line.ship_line_id,\n        shipment_line.ordnum,\n        shipment_line.ordlin,\n        shipment_line.prtnum,\n        shipment_line.shpqty\n   ${baseFrom}\n   join shipment_line shipment_line\n     on shipment.ship_id = shipment_line.ship_id\n    and shipment.wh_id = shipment_line.wh_id\n  ${baseWhere}]`
  }
  if (mode.includes('picked-lpn')) {
    return `[select trlr.trlr_id,\n        trlr.trlr_num,\n        trlr.yard_loc,\n        trlr.trlr_stat,\n        car_move.carcod,\n        stop.stop_id,\n        shipment.ship_id,\n        shipment_line.ship_line_id,\n        shipment_line.ordnum,\n        shipment_line.ordlin,\n        shipment_line.prtnum,\n        inventory_pckwrk_view.lodnum,\n        inventory_pckwrk_view.lotnum,\n        inventory_pckwrk_view.stoloc,\n        inventory_pckwrk_view.pckqty\n   ${baseFrom}\n   join shipment_line shipment_line\n     on shipment.ship_id = shipment_line.ship_id\n    and shipment.wh_id = shipment_line.wh_id\n   left join inventory_pckwrk_view\n     on shipment_line.ship_line_id = inventory_pckwrk_view.ship_line_id\n  ${baseWhere}]`
  }
  if (mode.includes('summary')) {
    return `[select trlr.trlr_id,\n        trlr.trlr_num,\n        trlr.yard_loc,\n        trlr.trlr_stat,\n        car_move.carcod,\n        stop.stop_id,\n        shipment.ship_id,\n        shipment.shpsts,\n        count(distinct shipment_line.ship_line_id) as ship_line_count,\n        count(distinct inventory_pckwrk_view.lodnum) as loaded_lpn_count,\n        sum(inventory_pckwrk_view.pckqty) as loaded_qty\n   ${baseFrom}\n   left join shipment_line shipment_line\n     on shipment.ship_id = shipment_line.ship_id\n    and shipment.wh_id = shipment_line.wh_id\n   left join inventory_pckwrk_view\n     on shipment_line.ship_line_id = inventory_pckwrk_view.ship_line_id\n  ${baseWhere}\n  group by trlr.trlr_id,\n           trlr.trlr_num,\n           trlr.yard_loc,\n           trlr.trlr_stat,\n           car_move.carcod,\n           stop.stop_id,\n           shipment.ship_id,\n           shipment.shpsts]`
  }
  return `[select trlr.trlr_id,\n        trlr.trlr_num,\n        trlr.yard_loc,\n        trlr.trlr_stat,\n        car_move.carcod,\n        stop.stop_id,\n        shipment.ship_id,\n        shipment.shpsts,\n        shipment_line.ship_line_id,\n        shipment_line.ordnum,\n        shipment_line.ordlin,\n        shipment_line.prtnum,\n        shipment_line.shpqty,\n        inventory_pckwrk_view.lodnum,\n        inventory_pckwrk_view.lotnum,\n        inventory_pckwrk_view.stoloc,\n        inventory_pckwrk_view.pckqty\n   ${baseFrom}\n   join shipment_line shipment_line\n     on shipment.ship_id = shipment_line.ship_id\n    and shipment.wh_id = shipment_line.wh_id\n   left join inventory_pckwrk_view\n     on shipment_line.ship_line_id = inventory_pckwrk_view.ship_line_id\n  ${baseWhere}]`
}

function buildMultiboxOutput(values, mode) {
  if (!values.length) return ''
  const col = mode === 'multibox-by-inbound' ? 'movref' : 'prtnum'
  const filter = values.length === 1
    ? `${col} = '${escapeSql(values[0])}'`
    : `${col} in (${values.map(v => `'${escapeSql(v)}'`).join(', ')})`
  return `[select prtnum,\n        to_lodnum as created_lpn,\n        trnqty,\n        movref,\n        frstol,\n        tostol\n   from dlytrn\n  where to_lodnum is not null\n    and trnqty is not null\n    and ${filter}]`
}

function buildPrtdscOutput(values, mode) {
  if (!values.length) return ''
  const locale = mode === 'prtdsc-en' ? 'en-us' : 'es-es'
  const baseFilter = values.length === 1
    ? `colval like '${escapeSql(values[0])}%'`
    : values.map(v => `colval like '${escapeSql(v)}%'`).join('\n     or ')
  return `[select colval,\n        locale_id,\n        lngdsc\n   from prtdsc\n  where (${baseFilter})\n    and locale_id = '${locale}'\n    and colval like '%y10']`
}

const TOOLS = ['prtnum', 'prtdsc', 'locmst', 'receiving', 'shipping', 'multibox']

const TOOL_META = {
  prtnum: {
    title: 'PRTNUM Formatter',
    subtitle: 'Paste one Excel column or a mixed list and generate ready-to-use output fast.',
    kicker: 'Formatting',
    short: 'PRTNUM',
    desc: 'Comma lists and PRTMST query.',
    inputLabel: 'PRTNUM input',
    placeholder: `Paste one column from Excel or a mixed list, for example:\n5274757-329\n5456837-070P2\n5439088`,
  },
  prtdsc: {
    title: 'PRTDSC Description Finder',
    subtitle: 'Use the same pasted PRTNUM column and generate a description lookup query for PRTDSC.',
    kicker: 'Descriptions',
    short: 'PRTDSC',
    desc: 'Find descriptions by pasted PRTNUM list.',
    inputLabel: 'PRTNUM input for PRTDSC',
    placeholder: `Paste one column of part numbers, for example:\n1337313\n7557237\n7556045\n7555954\n5459390-070`,
  },
  locmst: {
    title: 'LOCMST Verification Tool',
    subtitle: 'Verification, operational, capacity, and strategy checks for one location or multiple locations.',
    kicker: 'Location checks',
    short: 'LOCMST',
    desc: 'Verification, status, capacity, and strategy.',
    inputLabel: 'LOCMST input',
    placeholder: `Verification modes:\nY27013    44612\nY27014    78614\n\nOther LOCMST checks:\nY27013\nY27014\nY27015`,
  },
  receiving: {
    title: 'Receiving Queries',
    subtitle: 'Use RDCK or trailer entry points and switch between full detail, line detail, split detail, and summary.',
    kicker: 'Receiving',
    short: 'RDCK / Trailer',
    desc: 'Detail, line, split, and summary views.',
    inputLabel: 'Receiving input',
    placeholder: `By RDCK:\nRDCK02\nRDCK05\n\nBy trailer number:\nWEDETEST3\nTRAILER-TRAINING01`,
  },
  shipping: {
    title: 'Shipping Queries',
    subtitle: 'Use trailer or shipment entry points and switch between shipment header, line, picked LPN, combined detail, and summary.',
    kicker: 'Shipping',
    short: 'Trailer / Shipment',
    desc: 'Header, line, picked LPN, and summary.',
    inputLabel: 'Shipping input',
    placeholder: `By trailer number:\nTRL0000118\nTRL0000119\n\nBy shipment:\nSID0000402\nSID0000403`,
  },
  multibox: {
    title: 'Multibox Created Boxes',
    subtitle: 'Check created child LPNs by inbound or by part without mixing the result back into the main receiving query.',
    kicker: 'Receiving helper',
    short: 'Multibox',
    desc: 'Created child boxes by inbound or part.',
    inputLabel: 'Multibox input',
    placeholder: `By inbound:\nRCV-TRAINING-02\n\nBy part:\n3023571`,
  },
}

const DEFAULT_MODES = {
  prtnum: 'quoted',
  prtdsc: 'prtdsc-es',
  locmst: 'locmst-query',
  receiving: 'receiving-detail-rdck',
  shipping: 'shipping-detail-trailer',
  multibox: 'multibox-by-inbound',
}

function loadSaved() {
  try {
    const s = localStorage.getItem('wms-state')
    return s ? JSON.parse(s) : null
  } catch { return null }
}

function HintBox({ id, title, openHints, onToggle, children }) {
  return (
    <div className="hint-box">
      <button className="hint-toggle" onClick={() => onToggle(id)}>
        <strong>{title}</strong>
        <span className="hint-chevron">{openHints[id] ? '▴' : '▾'}</span>
      </button>
      {openHints[id] && <div className="hint-content">{children}</div>}
    </div>
  )
}

export default function App() {
  const saved = useMemo(loadSaved, [])

  const [tool, setTool] = useState(saved?.tool ?? 'prtnum')
  const [inputs, setInputs] = useState({ ...Object.fromEntries(TOOLS.map(t => [t, ''])), ...saved?.inputs })
  const [modes, setModes] = useState({ ...DEFAULT_MODES, ...saved?.modes })
  const [darkMode, setDarkMode] = useState(saved?.darkMode ?? false)
  const [copied, setCopied] = useState(false)
  const [undoEntry, setUndoEntry] = useState(null)
  const [history, setHistory] = useState(saved?.history ?? [])
  const [showHistory, setShowHistory] = useState(false)
  const [openHints, setOpenHints] = useState({})

  const input = inputs[tool]
  const setInput = useCallback(v => setInputs(p => ({ ...p, [tool]: v })), [tool])

  const setPrtnumMode = v => setModes(p => ({ ...p, prtnum: v }))
  const setPrtdscMode = v => setModes(p => ({ ...p, prtdsc: v }))
  const setLocmstMode = v => setModes(p => ({ ...p, locmst: v }))
  const setReceivingMode = v => setModes(p => ({ ...p, receiving: v }))
  const setShippingMode = v => setModes(p => ({ ...p, shipping: v }))
  const setMultiboxMode = v => setModes(p => ({ ...p, multibox: v }))

  const prtnumMode = modes.prtnum
  const prtdscMode = modes.prtdsc
  const locmstMode = modes.locmst
  const receivingMode = modes.receiving
  const shippingMode = modes.shipping
  const multiboxMode = modes.multibox

  const prtnumItems = useMemo(() => parseSingleColumn(inputs.prtnum), [inputs.prtnum])
  const parsedPairs = useMemo(() => parseLocationPairs(inputs.locmst), [inputs.locmst])
  const locmstLocations = useMemo(() => parseSingleColumn(inputs.locmst), [inputs.locmst])
  const receivingValues = useMemo(() => parseSingleColumn(inputs.receiving), [inputs.receiving])
  const shippingValues = useMemo(() => parseSingleColumn(inputs.shipping), [inputs.shipping])
  const multiboxValues = useMemo(() => parseSingleColumn(inputs.multibox), [inputs.multibox])
  const prtdscValues = useMemo(() => parseSingleColumn(inputs.prtdsc), [inputs.prtdsc])

  const validPairs = useMemo(() => parsedPairs.filter(r => r.valid), [parsedPairs])
  const invalidPairs = useMemo(() => parsedPairs.filter(r => !r.valid), [parsedPairs])

  const currentItems = useMemo(() => {
    if (tool === 'locmst') return locmstLocations
    if (tool === 'receiving') return receivingValues
    if (tool === 'shipping') return shippingValues
    if (tool === 'multibox') return multiboxValues
    if (tool === 'prtdsc') return prtdscValues
    return prtnumItems
  }, [tool, locmstLocations, receivingValues, shippingValues, multiboxValues, prtdscValues, prtnumItems])

  const duplicateCount = useMemo(() => {
    const seen = new Set()
    let n = 0
    currentItems.forEach(v => { if (seen.has(v)) n++; seen.add(v) })
    return n
  }, [currentItems])

  const autoDetect = useMemo(() => {
    if (!input.trim() || currentItems.length === 0) return null
    if (currentItems.every(v => /^TRL/i.test(v)) && tool !== 'shipping')
      return { suggestTool: 'shipping', suggestMode: 'shipping-detail-trailer', label: 'Looks like trailer numbers — switch to Shipping?' }
    if (currentItems.every(v => /^RDCK/i.test(v)) && tool !== 'receiving')
      return { suggestTool: 'receiving', suggestMode: 'receiving-detail-rdck', label: 'Looks like RDCK / yard_loc — switch to Receiving?' }
    if (currentItems.every(v => /^SID/i.test(v)) && tool !== 'shipping')
      return { suggestTool: 'shipping', suggestMode: 'shipping-detail-shipment', label: 'Looks like shipment IDs — switch to Shipping?' }
    if (currentItems.every(v => /^RCV-/i.test(v)) && tool !== 'multibox')
      return { suggestTool: 'multibox', suggestMode: 'multibox-by-inbound', label: 'Looks like inbound references — switch to Multibox?' }
    return null
  }, [input, currentItems, tool])

  const locmstNeedsPairs = ['locmst-query', 'confirm-match', 'pairs-only'].includes(locmstMode)
  const locmstRowsPasted = locmstNeedsPairs ? parsedPairs.length : locmstLocations.length
  const locmstRowsOutput = locmstNeedsPairs ? validPairs.length : locmstLocations.length
  const locmstCountsMatch = locmstNeedsPairs
    ? parsedPairs.length === validPairs.length
    : locmstLocations.length > 0 ? locmstLocations.length === locmstRowsOutput : true

  const output = useMemo(() => {
    if (tool === 'locmst') return buildLocmstOutput(validPairs, locmstLocations, locmstMode)
    if (tool === 'receiving') return buildReceivingOutput(receivingValues, receivingMode)
    if (tool === 'shipping') return buildShippingOutput(shippingValues, shippingMode)
    if (tool === 'multibox') return buildMultiboxOutput(multiboxValues, multiboxMode)
    if (tool === 'prtdsc') return buildPrtdscOutput(prtdscValues, prtdscMode)
    return buildPrtnumOutput(prtnumItems, prtnumMode)
  }, [tool, validPairs, locmstLocations, locmstMode, receivingValues, receivingMode, shippingValues, shippingMode, multiboxValues, multiboxMode, prtdscValues, prtdscMode, prtnumItems, prtnumMode])

  const inputCount = tool === 'locmst' ? locmstRowsPasted : currentItems.length
  const outputCount = tool === 'locmst' ? locmstRowsOutput : inputCount
  const countsMatch = tool === 'locmst'
    ? locmstCountsMatch
    : inputCount > 0 ? inputCount === outputCount : true

  const toolCounts = useMemo(() => ({
    prtnum: prtnumItems.length,
    prtdsc: prtdscValues.length,
    locmst: locmstLocations.length,
    receiving: receivingValues.length,
    shipping: shippingValues.length,
    multibox: multiboxValues.length,
  }), [prtnumItems.length, prtdscValues.length, locmstLocations.length, receivingValues.length, shippingValues.length, multiboxValues.length])

  useEffect(() => {
    try {
      localStorage.setItem('wms-state', JSON.stringify({ tool, inputs, modes, darkMode, history }))
    } catch {}
  }, [tool, inputs, modes, darkMode, history])

  useEffect(() => {
    document.documentElement.setAttribute('data-dark', darkMode ? '1' : '0')
  }, [darkMode])

  const outputRef = useRef('')
  const inputRef = useRef('')
  const toolRef = useRef('prtnum')
  const modesRef = useRef(DEFAULT_MODES)
  useEffect(() => { outputRef.current = output }, [output])
  useEffect(() => { inputRef.current = input }, [input])
  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { modesRef.current = modes }, [modes])

  const copyTimerRef = useRef(null)
  const undoTimerRef = useRef(null)

  const doCopy = useCallback(async () => {
    const out = outputRef.current
    if (!out) return
    try {
      await navigator.clipboard.writeText(out)
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
      const t = toolRef.current
      setHistory(prev => [{
        id: Date.now(),
        tool: t,
        output: out,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }, ...prev].slice(0, 15))
    } catch {}
  }, [])

  const clearAll = useCallback(() => {
    const t = toolRef.current
    const v = inputRef.current
    if (!v) return
    setUndoEntry({ tool: t, value: v })
    setInputs(p => ({ ...p, [t]: '' }))
    clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setUndoEntry(null), 6000)
  }, [])

  function handleUndo() {
    if (!undoEntry) return
    setInputs(p => ({ ...p, [undoEntry.tool]: undoEntry.value }))
    setUndoEntry(null)
  }

  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); doCopy(); return }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); clearAll(); return }
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return
      const idx = parseInt(e.key) - 1
      if (idx >= 0 && idx < TOOLS.length) setTool(TOOLS[idx])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doCopy, clearAll])

  function dedupeInput() {
    setInput([...new Set(parseSingleColumn(input))].join('\n'))
  }
  function uppercaseInput() { setInput(input.toUpperCase()) }
  function trimInput() { setInput(parseSingleColumn(input).join('\n')) }

  function applyAutoDetect(det) {
    setInputs(p => ({ ...p, [det.suggestTool]: input }))
    setModes(p => ({ ...p, [det.suggestTool]: det.suggestMode }))
    setTool(det.suggestTool)
  }

  function toggleHint(id) { setOpenHints(p => ({ ...p, [id]: !p[id] })) }

  const activeMeta = TOOL_META[tool]

  return (
    <div className="page">
      <div className="shell">
        <aside className="sidebar card-panel">
          <div className="brand-block">
            <span className="eyebrow">WMS helper</span>
            <h2>Query tools</h2>
            <p>Keep the working outputs, add new ones, and switch tools without touching the old logic.</p>
          </div>

          <div className="tool-list">
            {TOOLS.map((t, i) => (
              <button
                key={t}
                className={`tool-tile ${tool === t ? 'selected' : ''}`}
                onClick={() => setTool(t)}
              >
                <div className="tool-tile-top">
                  <span className="tool-kicker">{TOOL_META[t].kicker}</span>
                  <div className="tile-badges">
                    {toolCounts[t] > 0 && <span className="tile-count">{toolCounts[t]}</span>}
                    <span className="tile-shortcut">{i + 1}</span>
                  </div>
                </div>
                <strong>{TOOL_META[t].short}</strong>
                <small>{TOOL_META[t].desc}</small>
              </button>
            ))}
          </div>

          <div className="sidebar-footer">
            <button className="sidebar-toggle" onClick={() => setDarkMode(d => !d)}>
              {darkMode ? '☀ Light mode' : '☾ Dark mode'}
            </button>
          </div>
        </aside>

        <main className="card-panel workspace">
          <div className="workspace-header">
            <div>
              <span className="eyebrow">Active tool</span>
              <h1>{activeMeta.title}</h1>
              <p className="subtitle">{activeMeta.subtitle}</p>
            </div>
            <div className="header-actions">
              <button
                className={`icon-btn ${showHistory ? 'active' : ''}`}
                onClick={() => setShowHistory(h => !h)}
                title="Query history"
              >
                History {history.length > 0 && <span className="history-badge">{history.length}</span>}
              </button>
            </div>
          </div>

          <div className="stats-grid">
            <div className="stat-card"><span className="label">Rows pasted</span><strong>{inputCount}</strong></div>
            <div className="stat-card"><span className="label">Rows in output</span><strong>{outputCount}</strong></div>
            <div className={`stat-card ${countsMatch ? 'ok' : 'bad'}`}>
              <span className="label">Count check</span>
              <strong>{countsMatch ? 'MATCH' : 'CHECK'}</strong>
            </div>
            {duplicateCount > 0 && (
              <div className="stat-card warn">
                <span className="label">Duplicates</span>
                <strong>{duplicateCount}</strong>
              </div>
            )}
          </div>

          {autoDetect && (
            <div className="detect-banner">
              <span>{autoDetect.label}</span>
              <button onClick={() => applyAutoDetect(autoDetect)}>Apply</button>
            </div>
          )}

          <div className="editor-grid">
            <section className="editor-panel">
              <div className="input-label-row">
                <label className="section-label" htmlFor="input">{activeMeta.inputLabel}</label>
                <div className="cleanup-row">
                  {duplicateCount > 0 && (
                    <button className="xs-btn warn-btn" onClick={dedupeInput}>
                      Dedupe ({duplicateCount})
                    </button>
                  )}
                  <button className="xs-btn" onClick={uppercaseInput} title="Convert all to uppercase">AA</button>
                  <button className="xs-btn" onClick={trimInput} title="Strip whitespace and empty rows">Trim</button>
                </div>
              </div>
              <textarea
                id="input"
                placeholder={activeMeta.placeholder}
                value={input}
                onChange={e => setInput(e.target.value)}
              />
            </section>

            <section className="editor-panel options-panel">
              <label className="section-label">Options</label>

              {tool === 'prtnum' && (
                <>
                  <div className="pill-group">
                    <button className={prtnumMode === 'quoted' ? 'active' : ''} onClick={() => setPrtnumMode('quoted')}>SQL quoted comma</button>
                    <button className={prtnumMode === 'prtmst-query' ? 'active' : ''} onClick={() => setPrtnumMode('prtmst-query')}>PRTMST query</button>
                    <button className={prtnumMode === 'prtmst-useful' ? 'active' : ''} onClick={() => setPrtnumMode('prtmst-useful')}>PRTMST useful</button>
                    <button className={prtnumMode === 'plain' ? 'active' : ''} onClick={() => setPrtnumMode('plain')}>Plain comma</button>
                    <button className={prtnumMode === 'quoted-lines' ? 'active' : ''} onClick={() => setPrtnumMode('quoted-lines')}>One per line + comma</button>
                  </div>
                  <HintBox id="prtnum" title="PRTMST queries" openHints={openHints} onToggle={toggleHint}>
                    <code>[select prtnum, prtfam from prtmst where prtnum in ('5274757-329', '5456837-070P2')]</code>
                  </HintBox>
                </>
              )}

              {tool === 'prtdsc' && (
                <>
                  <div className="pill-group">
                    <button className={prtdscMode === 'prtdsc-es' ? 'active' : ''} onClick={() => setPrtdscMode('prtdsc-es')}>es-es</button>
                    <button className={prtdscMode === 'prtdsc-en' ? 'active' : ''} onClick={() => setPrtdscMode('prtdsc-en')}>en-us</button>
                  </div>
                  <HintBox id="prtdsc" title="PRTDSC lookup" openHints={openHints} onToggle={toggleHint}>
                    <code>[select colval, locale_id, lngdsc from prtdsc where (colval like '1337313%' or colval like '7557237%') and locale_id = 'es-es' and colval like '%y10']</code>
                  </HintBox>
                </>
              )}

              {tool === 'locmst' && (
                <>
                  <div className="pill-group">
                    <button className={locmstMode === 'locmst-query' ? 'active' : ''} onClick={() => setLocmstMode('locmst-query')}>LOCMST query</button>
                    <button className={locmstMode === 'confirm-match' ? 'active' : ''} onClick={() => setLocmstMode('confirm-match')}>Confirm match</button>
                    <button className={locmstMode === 'locations-only' ? 'active' : ''} onClick={() => setLocmstMode('locations-only')}>Locations only query</button>
                    <button className={locmstMode === 'pairs-only' ? 'active' : ''} onClick={() => setLocmstMode('pairs-only')}>Conditions only</button>
                    <button className={locmstMode === 'operational-check' ? 'active' : ''} onClick={() => setLocmstMode('operational-check')}>Operational check</button>
                    <button className={locmstMode === 'capacity-check' ? 'active' : ''} onClick={() => setLocmstMode('capacity-check')}>Capacity check</button>
                    <button className={locmstMode === 'strategy-friendly' ? 'active' : ''} onClick={() => setLocmstMode('strategy-friendly')}>Friendly strategy check</button>
                  </div>
                  <HintBox id="locmst" title={locmstNeedsPairs ? 'Verification modes' : 'Location-based checks'} openHints={openHints} onToggle={toggleHint}>
                    {locmstNeedsPairs
                      ? <code>[select exp.expected_stoloc as stoloc, exp.expected_locvrc, loc.locvrc as db_locvrc, case when loc.stoloc is null then 'NOT FOUND' when loc.locvrc = exp.expected_locvrc then 'MATCH' else 'MISMATCH' end as match_status from (...) exp left join locmst loc on loc.stoloc = exp.expected_stoloc]</code>
                      : <code>[select l.stoloc, l.velzon as velocity_zone, l.pck_zone_id, pck_zone.pck_zone_cod as pck_zone ... from locmst l ...]</code>
                    }
                  </HintBox>
                  {!!invalidPairs.length && locmstNeedsPairs && (
                    <div className="warning-box">
                      <strong>Skipped rows</strong>
                      <pre>{invalidPairs.map(r => r.raw).join('\n')}</pre>
                    </div>
                  )}
                </>
              )}

              {tool === 'receiving' && (
                <>
                  <div className="option-group">
                    <span className="group-title">Entry point</span>
                    <div className="pill-group">
                      <button className={receivingMode.includes('rdck') ? 'active' : ''} onClick={() => setReceivingMode(receivingMode.replace('trailer', 'rdck'))}>By RDCK / yard_loc</button>
                      <button className={receivingMode.includes('trailer') ? 'active' : ''} onClick={() => setReceivingMode(receivingMode.replace('rdck', 'trailer'))}>By trailer number</button>
                    </div>
                  </div>
                  <div className="option-group">
                    <span className="group-title">Query shape</span>
                    <div className="pill-group">
                      <button className={receivingMode.includes('detail') && !receivingMode.includes('line') ? 'active' : ''} onClick={() => setReceivingMode(receivingMode.includes('rdck') ? 'receiving-detail-rdck' : 'receiving-detail-trailer')}>Main detail</button>
                      <button className={receivingMode.includes('line-detail') ? 'active' : ''} onClick={() => setReceivingMode(receivingMode.includes('rdck') ? 'receiving-line-detail-rdck' : 'receiving-line-detail-trailer')}>Line detail</button>
                      <button className={receivingMode.includes('inventory-split') ? 'active' : ''} onClick={() => setReceivingMode(receivingMode.includes('rdck') ? 'receiving-inventory-split-rdck' : 'receiving-inventory-split-trailer')}>Inventory split</button>
                      <button className={receivingMode.includes('summary') ? 'active' : ''} onClick={() => setReceivingMode(receivingMode.includes('rdck') ? 'receiving-summary-rdck' : 'receiving-summary-trailer')}>Line vs inventory summary</button>
                    </div>
                  </div>
                  <HintBox id="receiving" title="Receiving queries" openHints={openHints} onToggle={toggleHint}>
                    <code>Use main detail for the combined view, line detail for one row per rcvkey, inventory split for one row per created inventory row, and summary when the combined view starts to repeat too much.</code>
                  </HintBox>
                </>
              )}

              {tool === 'shipping' && (
                <>
                  <div className="option-group">
                    <span className="group-title">Entry point</span>
                    <div className="pill-group">
                      <button className={shippingMode.includes('trailer') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.replace('shipment', 'trailer'))}>By trailer number</button>
                      <button className={shippingMode.includes('shipment') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.replace('trailer', 'shipment'))}>By shipment</button>
                    </div>
                  </div>
                  <div className="option-group">
                    <span className="group-title">Query shape</span>
                    <div className="pill-group">
                      <button className={shippingMode.includes('detail') && !shippingMode.includes('line') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.includes('trailer') ? 'shipping-detail-trailer' : 'shipping-detail-shipment')}>Combined detail</button>
                      <button className={shippingMode.includes('header') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.includes('trailer') ? 'shipping-header-trailer' : 'shipping-header-shipment')}>Shipment header</button>
                      <button className={shippingMode.includes('line-detail') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.includes('trailer') ? 'shipping-line-detail-trailer' : 'shipping-line-detail-shipment')}>Line detail</button>
                      <button className={shippingMode.includes('picked-lpn') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.includes('trailer') ? 'shipping-picked-lpn-trailer' : 'shipping-picked-lpn-shipment')}>Picked LPN detail</button>
                      <button className={shippingMode.includes('summary') ? 'active' : ''} onClick={() => setShippingMode(shippingMode.includes('trailer') ? 'shipping-summary-trailer' : 'shipping-summary-shipment')}>Shipment summary</button>
                    </div>
                  </div>
                  <HintBox id="shipping" title="Shipping queries" openHints={openHints} onToggle={toggleHint}>
                    <code>Start with shipment header to confirm trailer-stop-shipment linkage, move to line detail for shipment_line rows, use picked LPN detail for live loaded inventory, and use summary when the combined detail repeats too much.</code>
                  </HintBox>
                </>
              )}

              {tool === 'multibox' && (
                <>
                  <div className="pill-group">
                    <button className={multiboxMode === 'multibox-by-inbound' ? 'active' : ''} onClick={() => setMultiboxMode('multibox-by-inbound')}>By inbound</button>
                    <button className={multiboxMode === 'multibox-by-part' ? 'active' : ''} onClick={() => setMultiboxMode('multibox-by-part')}>By part</button>
                  </div>
                  <HintBox id="multibox" title="Multibox helper" openHints={openHints} onToggle={toggleHint}>
                    <code>[select prtnum, to_lodnum as created_lpn, trnqty, movref, frstol, tostol from dlytrn where to_lodnum is not null and trnqty is not null ...]</code>
                  </HintBox>
                </>
              )}
            </section>
          </div>

          <section className="output-panel">
            <div className="output-label-row">
              <label className="section-label" htmlFor="output">Output</label>
              {output && <span className="char-count">{output.length.toLocaleString()} chars</span>}
            </div>
            <textarea
              id="output"
              value={output}
              readOnly
              placeholder="Formatted output appears here"
              onClick={e => e.target.select()}
            />
            <div className="actions">
              <button className={copied ? 'copied' : ''} onClick={doCopy}>
                {copied ? 'Copied!' : 'Copy output'}
                {!copied && <kbd>Ctrl+Enter</kbd>}
              </button>
              <button className="secondary" onClick={clearAll}>
                Clear <kbd>Ctrl+L</kbd>
              </button>
              {undoEntry && (
                <button className="undo-btn" onClick={handleUndo}>↩ Undo clear</button>
              )}
            </div>
          </section>

          {showHistory && (
            <section className="history-panel">
              <div className="history-header">
                <strong>Query history</strong>
                <div className="history-header-actions">
                  <span className="muted-text">{history.length} saved</span>
                  {history.length > 0 && (
                    <button className="xs-btn" onClick={() => setHistory([])}>Clear all</button>
                  )}
                </div>
              </div>
              {history.length === 0 ? (
                <p className="muted-text">No history yet. Copy an output to save it here.</p>
              ) : (
                <div className="history-list">
                  {history.map(entry => (
                    <div key={entry.id} className="history-entry">
                      <div className="history-entry-meta">
                        <span className="tool-chip">{entry.tool}</span>
                        <span className="history-time">{entry.time}</span>
                      </div>
                      <code className="history-preview">
                        {entry.output.slice(0, 140)}{entry.output.length > 140 ? '…' : ''}
                      </code>
                      <button
                        className="xs-btn"
                        onClick={async () => { try { await navigator.clipboard.writeText(entry.output) } catch {} }}
                      >
                        Copy
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
