/* boostU · Belgian VAT & Tax Dashboard
   Single-file vanilla JS app, IIFE namespaces. State in localStorage key "btax.v1". */

/* ============================================================
   Helpers
============================================================ */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 11);

const fmtEUR = (n, dec=2) =>
  (n == null || isNaN(n) ? '–' : new Intl.NumberFormat('nl-BE', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: dec, maximumFractionDigits: dec
  }).format(n));
const fmtEUR0 = n => fmtEUR(n, 0);
const fmtPct = n => (n == null || isNaN(n) ? '–' : (n * 100).toFixed(1) + '%');

const toISODate = d => {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return '';
  const y = dt.getFullYear(), m = String(dt.getMonth()+1).padStart(2,'0'), day = String(dt.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const parseEUDate = s => {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return new Date(y, +m[2]-1, +m[1]);
  }
  const d = new Date(s); return isNaN(d) ? null : d;
};
const parseEuNum = s => {
  if (typeof s === 'number') return s;
  if (s == null) return NaN;
  s = String(s).trim().replace(/\s/g, '').replace(/EUR/i, '');
  // Belgian: "1.234,56" or "1234,56" or "-1.234,56"
  if (s.includes(',') && s.includes('.') && s.lastIndexOf(',') > s.lastIndexOf('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
};
const quarterOfDate = d => {
  const dt = (d instanceof Date) ? d : new Date(d);
  return Math.floor(dt.getMonth()/3) + 1;
};
const monthIso = d => toISODate(d).slice(0,7);
const addMonths = (d, n) => {
  const dt = new Date(d);
  dt.setMonth(dt.getMonth()+n);
  return dt;
};
const startOfMonth = d => { const dt = new Date(d); dt.setDate(1); dt.setHours(0,0,0,0); return dt; };
const endOfMonth = d => { const dt = new Date(d); dt.setMonth(dt.getMonth()+1, 0); dt.setHours(23,59,59,999); return dt; };

/* ============================================================
   Store — versioned localStorage
============================================================ */
const Store = (() => {
  const KEY = 'btax.v1';
  const DEFAULT = {
    version: 1,
    profile: {
      legalName: '',
      vatNumber: '',
      vatRegime: 'quarterly',
      fiscalYear: new Date().getFullYear(),
      directorSalaryGross: 0,
      directorBenefitsInKind: 0,
      expectedAnnualRevenue: 0,
      foundingYear: new Date().getFullYear(),
      isStartupSmall: false,
      affiliatedHoldingMajority: false,
      smallCompanyArt124: true,
      openingCashBalance: 0,
      openingCashDate: `${new Date().getFullYear()}-01-01`,
    },
    transactions: [],
    categorizationRules: [],
    manualEntries: [],
    vatPaymentsPlanned: [],
    advancePaymentsPlanned: [],
    socialContributionsPlanned: [],
    ui: { activeTab: 'overview', activeReviewTab: 'review', lastBackup: null, salaryWhatIf: 50000 },
  };

  let _state = null;
  const listeners = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT);
      const parsed = JSON.parse(raw);
      return mergeDefault(parsed);
    } catch (e) {
      console.warn('Store load failed', e);
      return structuredClone(DEFAULT);
    }
  }

  function mergeDefault(s) {
    const base = structuredClone(DEFAULT);
    base.profile = { ...base.profile, ...(s.profile || {}) };
    base.ui = { ...base.ui, ...(s.ui || {}) };
    base.transactions = s.transactions || [];
    base.categorizationRules = s.categorizationRules || [];
    base.manualEntries = s.manualEntries || [];
    base.vatPaymentsPlanned = s.vatPaymentsPlanned || [];
    base.advancePaymentsPlanned = s.advancePaymentsPlanned || [];
    base.socialContributionsPlanned = s.socialContributionsPlanned || [];
    base.version = s.version || 1;
    return base;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(_state));
    } catch (e) {
      console.error('Store save failed', e);
      UI.toast('Could not save (localStorage full?)', 'error');
    }
  }

  function get() { return _state; }

  function update(fn) {
    fn(_state);
    save();
    listeners.forEach(l => l(_state));
  }

  function subscribe(l) { listeners.add(l); return () => listeners.delete(l); }

  function exportJson() {
    return JSON.stringify(_state, null, 2);
  }

  function importJson(text) {
    const parsed = JSON.parse(text);
    _state = mergeDefault(parsed);
    save();
    listeners.forEach(l => l(_state));
  }

  function reset() {
    _state = structuredClone(DEFAULT);
    save();
    listeners.forEach(l => l(_state));
  }

  function init() { _state = load(); }

  return { init, get, update, subscribe, exportJson, importJson, reset, save };
})();

/* ============================================================
   Tax — pure functions for VAT, corp tax, advance pmts, social
============================================================ */
const Tax = (() => {
  // 2026 constants
  const STANDARD_VAT = 0.21;
  const CORP_STANDARD = 0.25;
  const CORP_REDUCED = 0.20;
  const REDUCED_BRACKET = 100_000;
  const MIN_DIRECTOR_SALARY = 50_000;       // 2026 indexed
  const SHORTFALL_PENALTY_RATE = 0.05;
  const SOCIAL_CONTRIB_RATE = 0.205;
  // AY 2027 (income year 2026)
  const SURCHARGE_RATE = 0.0675;
  const VA_CREDITS = { VA1: 0.09, VA2: 0.075, VA3: 0.06, VA4: 0.045 };
  const vaDueFor = (year) => ({
    VA1: `${year}-04-10`, VA2: `${year}-07-10`,
    VA3: `${year}-10-10`, VA4: `${year}-12-20`,
  });

  function vatForQuarter(state, year, q) {
    const txns = state.transactions.filter(t => {
      const d = parseEUDate(t.date);
      return d && d.getFullYear() === year && quarterOfDate(d) === q;
    });
    let outputVat = 0, inputVat = 0;
    for (const t of txns) {
      if (t.category === 'revenue') {
        outputVat += t.vatAmount || 0;
      } else if (t.category === 'expense') {
        inputVat += (t.vatAmount || 0) * (t.deductibilityPct || 1);
      }
    }
    const payable = Math.max(0, outputVat - inputVat);
    const refund = Math.max(0, inputVat - outputVat);
    const deadlines = {
      1: `${year}-04-25`,
      2: `${year}-07-25`,
      3: `${year}-10-25`,
      4: `${year+1}-01-25`,
    };
    return { quarter: `${year}Q${q}`, year, q, outputVat, inputVat, payable, refund, deadline: deadlines[q] };
  }

  function vatYear(state, year) {
    const quarters = [1,2,3,4].map(q => vatForQuarter(state, year, q));
    const totalPayable = quarters.reduce((s,q)=>s+q.payable,0);
    const totalRefund  = quarters.reduce((s,q)=>s+q.refund,0);
    return { quarters, totalPayable, totalRefund };
  }

  function annualBuckets(state, year) {
    let revenueNet = 0, deductibleExpensesNet = 0, expensesGross = 0;
    let revenueGross = 0;
    for (const t of state.transactions) {
      const d = parseEUDate(t.date);
      if (!d || d.getFullYear() !== year) continue;
      if (t.category === 'revenue') {
        revenueNet += t.netAmount || 0;
        revenueGross += (t.netAmount || 0) + (t.vatAmount || 0);
      } else if (t.category === 'expense') {
        deductibleExpensesNet += (t.netAmount || 0) * (t.deductibilityPct ?? 1);
        expensesGross += (t.netAmount || 0) + (t.vatAmount || 0);
      }
    }
    // Apply manual projections (kind: revenueProjection/expenseProjection)
    for (const m of state.manualEntries) {
      if (m.year && m.year !== year) continue;
      if (m.kind === 'revenueProjection') revenueNet += m.amount;
      if (m.kind === 'expenseProjection') deductibleExpensesNet += m.amount;
    }
    return { revenueNet, deductibleExpensesNet, revenueGross, expensesGross };
  }

  function corpTax(state, year, opts = {}) {
    const { revenueNet, deductibleExpensesNet } = annualBuckets(state, year);
    const salary = opts.salaryOverride ?? state.profile.directorSalaryGross ?? 0;
    const bik = state.profile.directorBenefitsInKind ?? 0;
    const social = salary * SOCIAL_CONTRIB_RATE;

    // Salary + social are deductible from corp income
    const profitBeforeTax = revenueNet - deductibleExpensesNet - salary - social;

    const reasons = [];
    if (!state.profile.smallCompanyArt124)
      reasons.push('Niet "kleine vennootschap" (art 1:24 WVV)');
    if (salary < MIN_DIRECTOR_SALARY)
      reasons.push(`Bezoldiging € ${salary.toLocaleString('nl-BE')} < € ${MIN_DIRECTOR_SALARY.toLocaleString('nl-BE')} (geïndexeerd minimum 2026)`);
    if (state.profile.affiliatedHoldingMajority)
      reasons.push('> 50% aandelen in handen van een andere vennootschap');
    const totalRem = salary + bik;
    if (totalRem > 0 && (bik / totalRem) > 0.20)
      reasons.push('Voordelen alle aard > 20% van totale bezoldiging');

    const qualifies = reasons.length === 0;
    let tax, rateLabel;
    if (qualifies) {
      const first = Math.min(Math.max(0, profitBeforeTax), REDUCED_BRACKET);
      const rest = Math.max(0, profitBeforeTax - REDUCED_BRACKET);
      tax = first * CORP_REDUCED + rest * CORP_STANDARD;
      rateLabel = '20% op eerste € 100k, 25% boven';
    } else {
      tax = Math.max(0, profitBeforeTax) * CORP_STANDARD;
      rateLabel = '25% standaard';
    }

    let shortfallPenalty = 0;
    if (state.profile.smallCompanyArt124 && salary < MIN_DIRECTOR_SALARY) {
      shortfallPenalty = (MIN_DIRECTOR_SALARY - salary) * SHORTFALL_PENALTY_RATE;
    }

    return {
      revenueNet, deductibleExpensesNet, salary, social,
      profitBeforeTax, tax, shortfallPenalty,
      totalCharge: tax + shortfallPenalty,
      qualifies, rateLabel, reasons,
      conditions: {
        smallCompanyArt124: !!state.profile.smallCompanyArt124,
        salaryOk: salary >= MIN_DIRECTOR_SALARY,
        notHoldingMajority: !state.profile.affiliatedHoldingMajority,
        bikOk: totalRem === 0 || (bik / totalRem) <= 0.20,
      },
    };
  }

  function advancePaymentPlan(state, year, estimatedTax) {
    const yearsSinceFounding = year - (state.profile.foundingYear || year);
    if (state.profile.isStartupSmall && yearsSinceFounding < 3) {
      return {
        exempt: true,
        note: 'Kleine startende vennootschap — vrijgesteld eerste 3 boekjaren',
        surchargeBase: 0, creditEarned: 0, residualSurcharge: 0,
        recommended: { even: {}, front: {} },
        plans: state.advancePaymentsPlanned,
      };
    }
    const surchargeBase = Math.max(0, estimatedTax) * SURCHARGE_RATE;

    const plans = state.advancePaymentsPlanned;
    let creditEarned = 0;
    for (const p of plans) {
      creditEarned += (p.amount || 0) * (VA_CREDITS[p.code] || 0);
    }
    const residualSurcharge = Math.max(0, surchargeBase - creditEarned);

    const evenAmt = Math.max(0, estimatedTax) / 4;
    const recommended = {
      even: { VA1: evenAmt, VA2: evenAmt, VA3: evenAmt, VA4: evenAmt },
      front: { VA1: Math.max(0, estimatedTax) * 0.75, VA2: 0, VA3: 0, VA4: 0 },
    };
    return { exempt: false, surchargeBase, creditEarned, residualSurcharge, recommended, plans };
  }

  function socialPlan(state, year) {
    const annual = (state.profile.directorSalaryGross || 0) * SOCIAL_CONTRIB_RATE;
    const quarter = annual / 4;
    return {
      annual,
      schedule: [
        { quarter: `${year}Q1`, dueDate: `${year}-03-31`, amount: quarter },
        { quarter: `${year}Q2`, dueDate: `${year}-06-30`, amount: quarter },
        { quarter: `${year}Q3`, dueDate: `${year}-09-30`, amount: quarter },
        { quarter: `${year}Q4`, dueDate: `${year}-12-31`, amount: quarter },
      ],
    };
  }

  return {
    STANDARD_VAT, MIN_DIRECTOR_SALARY, SURCHARGE_RATE, VA_CREDITS, vaDueFor,
    CORP_STANDARD, CORP_REDUCED, REDUCED_BRACKET, SOCIAL_CONTRIB_RATE,
    vatForQuarter, vatYear, annualBuckets, corpTax, advancePaymentPlan, socialPlan,
  };
})();

/* ============================================================
   Projection — month-by-month cash buffer
============================================================ */
const Projection = (() => {
  function cashBuffer(state, year, ctx) {
    const months = [];
    const start = startOfMonth(state.profile.openingCashDate || `${year}-01-01`);
    const end = endOfMonth(`${year}-12-31`);
    let cursor = new Date(start);
    let balance = state.profile.openingCashBalance || 0;

    // bucket actual cash flows by month
    const flowByMonth = {};
    for (const t of state.transactions) {
      const d = parseEUDate(t.date);
      if (!d || d.getFullYear() !== year) continue;
      const k = monthIso(d);
      if (!flowByMonth[k]) flowByMonth[k] = { in: 0, out: 0 };
      const gross = (t.netAmount || 0) + (t.vatAmount || 0);
      if (t.category === 'revenue') flowByMonth[k].in += gross;
      else if (t.category === 'expense' || t.category === 'non_deductible') flowByMonth[k].out += gross;
      else if (t.category === 'salary' || t.category === 'social_contribution'
            || t.category === 'vat_payment' || t.category === 'corp_tax_payment'
            || t.category === 'advance_payment') flowByMonth[k].out += gross;
    }

    // projection of remaining months from manual entries or run-rate
    const today = new Date();
    const monthsSeen = Object.keys(flowByMonth).length;
    const avgIn = monthsSeen ? Object.values(flowByMonth).reduce((s,m)=>s+m.in,0) / monthsSeen : 0;
    const avgOut = monthsSeen ? Object.values(flowByMonth).reduce((s,m)=>s+m.out,0) / monthsSeen : 0;
    const expRev = state.profile.expectedAnnualRevenue || 0;
    const expRevMonthly = expRev / 12;

    while (cursor <= end) {
      const k = monthIso(cursor);
      const inFuture = cursor > endOfMonth(today);
      let inflow, outflow;
      if (flowByMonth[k] && !inFuture) {
        inflow = flowByMonth[k].in;
        outflow = flowByMonth[k].out;
      } else if (inFuture) {
        inflow = expRevMonthly > 0 ? expRevMonthly * 1.21 : avgIn; // gross with VAT
        outflow = avgOut;
      } else {
        inflow = 0; outflow = 0;
      }
      balance += inflow - outflow;

      months.push({ month: k, inflow, outflow, balance, projected: inFuture });
      cursor = addMonths(cursor, 1);
    }

    // Reserve calculation (forward-looking from current month)
    const ctxx = ctx || {};
    const vatRemaining = (ctxx.vatRemainingPayable || 0);
    const corpTaxRemaining = Math.max(0, (ctxx.corpTaxEstimated || 0) - (ctxx.advancePaymentsPaidYTD || 0));
    const socialRemaining = ctxx.socialRemaining || 0;
    const totalReserved = vatRemaining + corpTaxRemaining + socialRemaining;

    const lastBalance = months.length ? months[months.length-1].balance : balance;
    const safeToSpend = lastBalance - totalReserved;

    return { months, totalReserved, lastBalance, safeToSpend, breakdown: { vatRemaining, corpTaxRemaining, socialRemaining } };
  }

  return { cashBuffer };
})();

/* ============================================================
   Parsers — bank CSV detection
============================================================ */
const Parsers = (() => {
  // Profiles for major Belgian banks. Each "score" function returns an int score (>=2 wins).
  const profiles = [
    {
      name: 'belfius',
      detect: (h) => score(h, ['Boekingsdatum', 'Bedrag', 'Tegenpartij']),
      map: row => ({
        date: row['Boekingsdatum'] || row['Valutadatum'],
        amount: parseEuNum(row['Bedrag']),
        counterparty: row['Naam tegenpartij'] || row['Tegenpartij'] || row['Mededeling'] || '',
        raw: JSON.stringify(row),
      }),
    },
    {
      name: 'kbc',
      detect: (h) => score(h, ['Rekeningnummer', 'Bedrag', 'Munt', 'Vrije mededeling']),
      map: row => ({
        date: row['Datum'] || row['Boekingsdatum'],
        amount: parseEuNum(row['Bedrag']),
        counterparty: row['Naam tegenpartij'] || row['Vrije mededeling'] || row['Mededeling'] || '',
        raw: JSON.stringify(row),
      }),
    },
    {
      name: 'bnp',
      detect: (h) => score(h, ['Sequence Number', 'Execution date', 'Amount', 'Counterparty']) ||
                    score(h, ['Volgnummer', 'Uitvoeringsdatum', 'Bedrag', 'Tegenpartij']),
      map: row => ({
        date: row['Execution date'] || row['Uitvoeringsdatum'] || row['Value date'],
        amount: parseEuNum(row['Amount'] || row['Bedrag']),
        counterparty: row['Counterparty'] || row['Tegenpartij'] || row['Details'] || '',
        raw: JSON.stringify(row),
      }),
    },
    {
      name: 'ing',
      detect: (h) => score(h, ['Datum', 'Omschrijving', 'Tegenrekening', 'Bedrag']),
      map: row => ({
        date: row['Datum'],
        amount: parseEuNum(row['Bedrag']),
        counterparty: row['Naam tegenpartij'] || row['Omschrijving'] || row['Mededeling'] || '',
        raw: JSON.stringify(row),
      }),
    },
    {
      name: 'argenta',
      detect: (h) => score(h, ['Boekdatum', 'Omschrijving', 'Bedrag']),
      map: row => ({
        date: row['Boekdatum'] || row['Valutadatum'],
        amount: parseEuNum(row['Bedrag']),
        counterparty: row['Omschrijving'] || row['Referentie'] || '',
        raw: JSON.stringify(row),
      }),
    },
    {
      name: 'generic',
      detect: () => 1,
      map: row => {
        // last-resort: pick first date-looking and amount-looking field
        let date = '', amount = NaN, cp = '';
        for (const [k, v] of Object.entries(row)) {
          if (/date|datum/i.test(k) && !date) date = v;
          else if (/amount|bedrag/i.test(k) && isNaN(amount)) amount = parseEuNum(v);
          else if (/description|omschrijving|tegen|counterparty|mededeling|details/i.test(k) && !cp) cp = v;
        }
        return { date, amount, counterparty: cp, raw: JSON.stringify(row) };
      },
    },
  ];

  function score(headers, needles) {
    let s = 0;
    for (const n of needles) if (headers.some(h => h && h.toLowerCase() === n.toLowerCase())) s++;
    return s >= 2 ? s : 0;
  }

  function detect(headers) {
    let best = profiles[profiles.length-1], bestScore = 1;
    for (const p of profiles.slice(0, -1)) {
      const sc = p.detect(headers);
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    return best;
  }

  function normalizeKey(s) {
    if (!s) return '';
    return String(s)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\b(bv|nv|srl|sa|bvba|comm\.?\s*v\.?|sprl|scs)\b/gi, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  }

  function parseCSV(text, fileName) {
    return new Promise((resolve, reject) => {
      // Try ; first (Belgian default), fall back to ,
      const tryParse = (delim) => Papa.parse(text, {
        header: true, delimiter: delim, skipEmptyLines: true,
        transformHeader: h => (h || '').trim(),
      });

      let res = tryParse(';');
      if (!res.data.length || Object.keys(res.data[0] || {}).length < 3) res = tryParse(',');
      if (!res.data.length) return reject(new Error('Geen rijen gevonden'));

      const headers = Object.keys(res.data[0] || {});
      const profile = detect(headers);
      const rows = [];
      res.data.forEach((row, i) => {
        const m = profile.map(row);
        const d = parseEUDate(m.date);
        if (!d || isNaN(m.amount)) return;
        rows.push({
          id: uid(),
          date: toISODate(d),
          amount: m.amount,
          counterparty: (m.counterparty || '').trim(),
          counterpartyKey: normalizeKey(m.counterparty),
          rawDescription: m.raw,
          bank: profile.name,
          category: 'unclassified',
          subCategory: null,
          vatRate: null,
          vatAmount: 0,
          netAmount: m.amount,
          deductibilityPct: 1,
          sourceFile: fileName,
          sourceRow: i + 2,
          manuallyEdited: false,
        });
      });
      resolve({ rows, profile: profile.name, headers });
    });
  }

  return { parseCSV, detect, normalizeKey, profiles };
})();

/* ============================================================
   Rules — categorization rule engine
============================================================ */
const Rules = (() => {
  function applyDefaultsForCategory(t) {
    // For a revenue/expense entry without VAT info, pre-fill standard 21%
    if (t.category === 'revenue' && t.vatRate == null) {
      t.vatRate = 21;
      // amount is gross income; split into net + VAT
      const gross = Math.abs(t.amount);
      t.netAmount = gross / 1.21;
      t.vatAmount = gross - t.netAmount;
    } else if (t.category === 'expense' && t.vatRate == null) {
      t.vatRate = 21;
      const gross = Math.abs(t.amount);
      t.netAmount = gross / 1.21;
      t.vatAmount = gross - t.netAmount;
      if (t.deductibilityPct == null) t.deductibilityPct = 1;
    }
    return t;
  }

  // Sub-category → default deductibilityPct & VAT rate
  const SUB = {
    office_supplies: { ded: 1.00, vat: 21 },
    software_saas:   { ded: 1.00, vat: 21 },
    mobile_internet: { ded: 0.75, vat: 21 },
    restaurant:      { ded: 0.69, vat: 12 },
    reception:       { ded: 0.50, vat: 21 },
    gift:            { ded: 0.50, vat: 21 },
    car_fuel:        { ded: 0.50, vat: 21 },
    car_lease:       { ded: 0.50, vat: 21 },
    home_office:     { ded: 0.30, vat: 21 },
    training:        { ded: 1.00, vat: 21 },
    accountant:      { ded: 1.00, vat: 21 },
    bank_fees:       { ded: 1.00, vat: 0  },
    insurance:       { ded: 1.00, vat: 0  },
    rent:            { ded: 1.00, vat: 0  },
    utilities:       { ded: 1.00, vat: 21 },
    other:           { ded: 1.00, vat: 21 },
  };

  function applySubCategoryDefaults(t) {
    if (!t.subCategory || !SUB[t.subCategory]) return t;
    const def = SUB[t.subCategory];
    if (t.deductibilityPct == null) t.deductibilityPct = def.ded;
    if (t.vatRate == null) t.vatRate = def.vat;
    return t;
  }

  function recomputeVat(t) {
    const rate = (t.vatRate || 0) / 100;
    const gross = Math.abs(t.amount);
    if (rate > 0) {
      t.netAmount = gross / (1 + rate);
      t.vatAmount = gross - t.netAmount;
    } else {
      t.netAmount = gross;
      t.vatAmount = 0;
    }
    return t;
  }

  function findRule(state, t) {
    for (const r of state.categorizationRules) {
      if (r.match.type === 'counterparty' && r.match.value === t.counterpartyKey) return r;
    }
    for (const r of state.categorizationRules) {
      if (r.match.type === 'contains' && t.counterpartyKey.includes(r.match.value)) return r;
    }
    return null;
  }

  function applyRule(t, rule) {
    Object.assign(t, rule.apply);
    return t;
  }

  function autoClassify(state, txns) {
    let n = 0;
    for (const t of txns) {
      if (t.manuallyEdited) continue;
      const rule = findRule(state, t);
      if (rule) {
        applyRule(t, rule);
        recomputeVat(t);
        n++;
      } else {
        // Heuristics: revenue when amount > 0 and looks like an invoice
        if (t.amount > 0 && t.category === 'unclassified') {
          // Don't auto-promote — let user review
        }
      }
    }
    return n;
  }

  function createOrUpdateRule(state, t) {
    if (!t.counterpartyKey || t.category === 'unclassified') return null;
    const existing = state.categorizationRules.find(
      r => r.match.type === 'counterparty' && r.match.value === t.counterpartyKey
    );
    const apply = {
      category: t.category,
      subCategory: t.subCategory,
      vatRate: t.vatRate,
      deductibilityPct: t.deductibilityPct,
    };
    if (existing) {
      existing.apply = apply;
      return existing;
    }
    const rule = {
      id: uid(),
      match: { type: 'counterparty', value: t.counterpartyKey },
      apply,
      counterpartyLabel: t.counterparty,
      createdAt: toISODate(new Date()),
    };
    state.categorizationRules.push(rule);
    return rule;
  }

  return { applyDefaultsForCategory, applySubCategoryDefaults, recomputeVat,
           autoClassify, findRule, applyRule, createOrUpdateRule, SUB };
})();

/* ============================================================
   Charts — hand-rolled SVG
============================================================ */
const Charts = (() => {
  function lineChart(container, points, opts={}) {
    container.innerHTML = '';
    if (!points.length) {
      container.innerHTML = '<div class="empty">Nog geen data om te tonen.</div>';
      return;
    }
    const W = opts.width || 720, H = opts.height || 220;
    const PAD = { l: 50, r: 12, t: 14, b: 28 };
    const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

    const xs = points.map((_,i) => i);
    const ys = points.map(p => p.value);
    const minY = Math.min(0, ...ys);
    const maxY = Math.max(...ys, 0);
    const yRange = (maxY - minY) || 1;

    const xAt = i => PAD.l + (i / Math.max(1, points.length - 1)) * innerW;
    const yAt = v => PAD.t + (1 - (v - minY) / yRange) * innerH;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Y gridlines (4 ticks)
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = minY + (yRange * i / ticks);
      const y = yAt(v);
      svg.insertAdjacentHTML('beforeend',
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" stroke="#1E2D4A" stroke-width="1" />` +
        `<text x="${PAD.l - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="#64748B" font-family="DM Sans">${shortEUR(v)}</text>`
      );
    }

    // Zero baseline
    if (minY < 0 && maxY > 0) {
      const y0 = yAt(0);
      svg.insertAdjacentHTML('beforeend',
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y0}" y2="${y0}" stroke="#475569" stroke-width="1" stroke-dasharray="3 3" />`);
    }

    // Path
    const lineD = points.map((p,i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${xAt(points.length-1).toFixed(1)},${yAt(minY).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(minY).toFixed(1)} Z`;
    const grad = `lg-${Math.random().toString(36).slice(2,8)}`;
    svg.insertAdjacentHTML('beforeend',
      `<defs><linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0%" stop-color="#06B6D4" stop-opacity="0.35"/>
         <stop offset="100%" stop-color="#06B6D4" stop-opacity="0"/>
       </linearGradient></defs>
       <path d="${areaD}" fill="url(#${grad})" />
       <path d="${lineD}" fill="none" stroke="#06B6D4" stroke-width="2" />`
    );

    // Future segment dashed
    if (opts.firstProjectedIdx != null && opts.firstProjectedIdx < points.length) {
      const fp = opts.firstProjectedIdx;
      const dashD = points.slice(fp).map((p,i) => `${i === 0 ? 'M' : 'L'}${xAt(fp+i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
      svg.insertAdjacentHTML('beforeend',
        `<path d="${dashD}" fill="none" stroke="#8B5CF6" stroke-width="2" stroke-dasharray="4 4" />`
      );
    }

    // Points + invisible hover targets
    points.forEach((p, i) => {
      const cx = xAt(i), cy = yAt(p.value);
      const isProj = opts.firstProjectedIdx != null && i >= opts.firstProjectedIdx;
      svg.insertAdjacentHTML('beforeend',
        `<circle cx="${cx}" cy="${cy}" r="3" fill="${isProj ? '#8B5CF6' : '#06B6D4'}" />` +
        `<circle data-i="${i}" cx="${cx}" cy="${cy}" r="14" fill="transparent" style="pointer-events:all;cursor:pointer;" />`
      );
    });

    // X-axis labels (every other point)
    points.forEach((p, i) => {
      if (i % Math.max(1, Math.ceil(points.length / 8)) !== 0 && i !== points.length-1) return;
      svg.insertAdjacentHTML('beforeend',
        `<text x="${xAt(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748B" font-family="DM Sans">${p.label}</text>`
      );
    });

    container.appendChild(svg);

    // Tooltip
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    container.appendChild(tip);

    container.querySelectorAll('circle[data-i]').forEach(c => {
      c.addEventListener('mouseenter', (e) => {
        const i = +c.getAttribute('data-i');
        const p = points[i];
        tip.innerHTML = `<div>${p.label}</div><strong>${fmtEUR(p.value)}</strong>${p.sub ? `<div class="dim">${p.sub}</div>` : ''}`;
        tip.style.display = 'block';
      });
      c.addEventListener('mousemove', (e) => {
        const rect = container.getBoundingClientRect();
        tip.style.left = (e.clientX - rect.left + 12) + 'px';
        tip.style.top  = (e.clientY - rect.top  + 12) + 'px';
      });
      c.addEventListener('mouseleave', () => tip.style.display = 'none');
    });
  }

  function barChart(container, groups, opts={}) {
    container.innerHTML = '';
    if (!groups.length) { container.innerHTML = '<div class="empty">Geen data.</div>'; return; }
    const W = opts.width || 720, H = opts.height || 200;
    const PAD = { l: 50, r: 12, t: 12, b: 30 };
    const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;

    const allVals = groups.flatMap(g => g.bars.map(b => b.value));
    const maxY = Math.max(...allVals, 1);

    const groupW = innerW / groups.length;
    const barW = Math.min(28, (groupW * 0.8) / Math.max(1, groups[0].bars.length));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // Y grid
    for (let i = 0; i <= 4; i++) {
      const v = maxY * i / 4;
      const y = PAD.t + innerH * (1 - i/4);
      svg.insertAdjacentHTML('beforeend',
        `<line x1="${PAD.l}" x2="${W-PAD.r}" y1="${y}" y2="${y}" stroke="#1E2D4A" stroke-width="1" />` +
        `<text x="${PAD.l-6}" y="${y+3}" text-anchor="end" font-size="10" fill="#64748B" font-family="DM Sans">${shortEUR(v)}</text>`
      );
    }

    groups.forEach((g, gi) => {
      const cx = PAD.l + groupW * (gi + 0.5);
      g.bars.forEach((b, bi) => {
        const h = (b.value / maxY) * innerH;
        const x = cx - (g.bars.length * barW)/2 + bi * barW;
        const y = PAD.t + innerH - h;
        const color = b.color || '#06B6D4';
        svg.insertAdjacentHTML('beforeend',
          `<rect x="${x}" y="${y}" width="${barW-2}" height="${Math.max(0,h)}" fill="${color}" rx="3" />`
        );
      });
      svg.insertAdjacentHTML('beforeend',
        `<text x="${cx}" y="${H-10}" text-anchor="middle" font-size="11" fill="#94A3B8" font-family="DM Sans">${g.label}</text>`);
    });

    container.appendChild(svg);
  }

  function shortEUR(v) {
    if (v == null || isNaN(v)) return '';
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return (v/1_000_000).toFixed(1) + 'M';
    if (abs >= 1_000) return (v/1_000).toFixed(1) + 'k';
    return Math.round(v).toString();
  }

  return { lineChart, barChart };
})();

/* ============================================================
   UI — panel renderers
============================================================ */
const UI = (() => {
  const TABS = [
    { id: 'overview',    label: 'Overzicht' },
    { id: 'transactions',label: 'Transacties' },
    { id: 'vat',         label: 'BTW' },
    { id: 'corp',        label: 'Vennootschapsbelasting' },
    { id: 'social',      label: 'Sociale bijdragen' },
    { id: 'advisor',     label: 'Uitgaven-adviseur' },
    { id: 'yearend',     label: 'Jaareinde' },
    { id: 'profile',     label: 'Profiel' },
  ];

  function setActiveTab(id) {
    Store.update(s => { s.ui.activeTab = id; });
    renderAll();
  }

  function toast(msg, kind='success') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast visible ' + kind;
    setTimeout(() => el.classList.remove('visible'), 3500);
  }

  function renderTopbar(state) {
    const yr = state.profile.fiscalYear;
    const ctx = computeContext(state, yr);
    const lastBal = ctx.cash.lastBalance;
    const safe = ctx.cash.safeToSpend;
    const company = state.profile.legalName || 'Jouw vennootschap';
    const vat = state.profile.vatNumber || '—';

    $('#topbar-company').textContent = company;
    $('#topbar-vat').textContent = vat;
    $('#kpi-balance').textContent = fmtEUR0(lastBal);
    $('#kpi-safe').textContent = fmtEUR0(safe);
    $('#kpi-safe').className = 'val ' + (safe < 0 ? 'rose' : (safe < 5000 ? 'amber' : 'emerald'));
  }

  function renderTabs(state) {
    const unclassified = state.transactions.filter(t => t.category === 'unclassified').length;
    const wrap = $('#tabs');
    wrap.innerHTML = '';
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.className = 'tab' + (state.ui.activeTab === t.id ? ' active' : '');
      btn.textContent = t.label;
      if (t.id === 'transactions' && unclassified) {
        btn.innerHTML += ` <span class="badge">${unclassified}</span>`;
      }
      btn.onclick = () => setActiveTab(t.id);
      wrap.appendChild(btn);
    }
  }

  function computeContext(state, year) {
    const vatY = Tax.vatYear(state, year);
    const corp = Tax.corpTax(state, year);
    const corpWhatIf = Tax.corpTax(state, year, { salaryOverride: state.ui.salaryWhatIf || 50000 });
    const ap = Tax.advancePaymentPlan(state, year, corp.totalCharge);
    const social = Tax.socialPlan(state, year);

    // VAT remaining payable (quarters whose deadline is in the future or unpaid)
    const today = new Date();
    let vatRemainingPayable = 0;
    for (const q of vatY.quarters) {
      const planned = state.vatPaymentsPlanned.find(p => p.quarter === q.quarter);
      if (planned && planned.paid) continue;
      if (parseEUDate(q.deadline) >= startOfMonth(today)) vatRemainingPayable += q.payable;
    }

    // Advance payments paid YTD
    const advancePaymentsPaidYTD = state.advancePaymentsPlanned
      .filter(p => p.paid)
      .reduce((s,p)=>s+(p.amount||0), 0);

    // Social remaining
    const socialRemaining = social.schedule
      .filter(s => parseEUDate(s.dueDate) >= startOfMonth(today))
      .reduce((s,x)=>s+x.amount, 0);

    const cash = Projection.cashBuffer(state, year, {
      vatRemainingPayable,
      corpTaxEstimated: corp.totalCharge,
      advancePaymentsPaidYTD,
      socialRemaining,
    });

    return { vatY, corp, corpWhatIf, ap, social, cash, year, vatRemainingPayable, advancePaymentsPaidYTD, socialRemaining };
  }

  function renderOverview(state, ctx) {
    const root = $('#panel-overview');
    const { vatY, corp, ap, cash } = ctx;

    const ytdRevenue = Tax.annualBuckets(state, ctx.year).revenueNet;
    const projectedProfit = corp.profitBeforeTax;
    const totalTax = corp.totalCharge + vatY.totalPayable + (state.profile.directorSalaryGross || 0) * Tax.SOCIAL_CONTRIB_RATE;

    const actions = buildActionItems(state, ctx);

    root.innerHTML = `
      <h1 class="panel-title">Overzicht ${ctx.year}</h1>
      <p class="panel-subtitle">Een real-time projectie van je geld, je belastingen en wat er komt richting 31 december.</p>

      <div class="kpi-grid">
        <div class="kpi cyan">
          <div class="lbl">Omzet YTD (excl. BTW)</div>
          <div class="val">${fmtEUR0(ytdRevenue)}</div>
          <div class="sub">van ${fmtEUR0(state.profile.expectedAnnualRevenue || 0)} verwacht</div>
        </div>
        <div class="kpi violet">
          <div class="lbl">Verwachte winst</div>
          <div class="val">${fmtEUR0(projectedProfit)}</div>
          <div class="sub">na bezoldiging & sociale bijdragen</div>
        </div>
        <div class="kpi amber">
          <div class="lbl">Totale belasting projectie</div>
          <div class="val">${fmtEUR0(totalTax)}</div>
          <div class="sub">BTW + venn.belasting + sociale bijdr.</div>
        </div>
        <div class="kpi ${cash.safeToSpend < 0 ? 'rose' : 'emerald'}">
          <div class="lbl">Veilig te besteden</div>
          <div class="val">${fmtEUR0(cash.safeToSpend)}</div>
          <div class="sub">na reserveringen</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="icon cyan">${icon('chart')}</span>
          <h3>Cash projectie tot 31 december</h3>
        </div>
        <div id="chart-cash" class="chart-wrap"></div>
        <div class="legend">
          <span><span class="dot" style="background:#06B6D4"></span>Werkelijke saldi</span>
          <span><span class="dot" style="background:#8B5CF6"></span>Projectie</span>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="icon amber">${icon('flag')}</span>
          <h3>Top actiepunten</h3>
        </div>
        ${actions.length === 0
          ? '<div class="empty">Geen acties — alles staat groen. ✨</div>'
          : `<ol class="actions">${actions.slice(0,5).map((a,i)=>`
              <li class="${a.color}">
                <span class="num">${i+1}</span>
                <div class="body"><strong>${a.title}</strong><div class="meta">${a.meta}</div></div>
              </li>`).join('')}</ol>`}
      </div>
    `;

    // Render cash chart
    const months = cash.months;
    const today = new Date();
    const firstProj = months.findIndex(m => m.projected);
    const points = months.map(m => ({
      label: m.month.slice(5) + '/' + m.month.slice(2,4),
      value: m.balance,
      sub: m.projected ? 'projectie' : 'werkelijk',
    }));
    Charts.lineChart($('#chart-cash'), points, { firstProjectedIdx: firstProj === -1 ? null : firstProj });
  }

  function buildActionItems(state, ctx) {
    const items = [];
    const today = new Date();

    // 1. Salary < €50k → highest priority
    if (state.profile.smallCompanyArt124 && state.profile.directorSalaryGross < Tax.MIN_DIRECTOR_SALARY) {
      const gap = Tax.MIN_DIRECTOR_SALARY - state.profile.directorSalaryGross;
      const corpSavings = ctx.corp.tax - ctx.corpWhatIf.tax;
      items.push({
        color: 'rose',
        title: `Verhoog bezoldiging met ${fmtEUR0(gap)} vóór 31 dec om 20% verlaagd tarief te behouden`,
        meta: `Bespaart ~${fmtEUR0(corpSavings)} aan venn.belasting + voorkomt 5% afzonderlijke heffing op het tekort (${fmtEUR0(gap*0.05)})`,
      });
    }

    // 2. Unclassified transactions
    const unclas = state.transactions.filter(t => t.category === 'unclassified').length;
    if (unclas > 0) {
      items.push({
        color: 'amber',
        title: `${unclas} transactie${unclas>1?'s':''} wachten op categorisatie`,
        meta: 'Open de Transacties-tab → Review om ze te classificeren',
      });
    }

    // 3. Next VAT deadline
    for (const q of ctx.vatY.quarters) {
      if (q.payable < 0.01) continue;
      const dl = parseEUDate(q.deadline);
      const planned = state.vatPaymentsPlanned.find(p => p.quarter === q.quarter);
      if (planned && planned.paid) continue;
      const days = Math.ceil((dl - today) / 86400000);
      if (days >= 0 && days <= 60) {
        items.push({
          color: days < 14 ? 'rose' : 'amber',
          title: `Betaal BTW Q${q.q} ${ctx.year}: ${fmtEUR0(q.payable)} tegen ${q.deadline}`,
          meta: `Nog ${days} dag${days===1?'':'en'}`,
        });
        break;
      }
    }

    // 4. Advance payment recommendation
    if (!ctx.ap.exempt && ctx.ap.residualSurcharge > 50) {
      // Suggest the next not-yet-paid VA
      const next = state.advancePaymentsPlanned.find(p => !p.paid);
      if (next) {
        const reco = ctx.ap.recommended.even[next.code] || 0;
        items.push({
          color: 'cyan',
          title: `Plan voorafbetaling ${next.code}: ~${fmtEUR0(reco)} tegen ${next.dueDate}`,
          meta: `Vermijdt €${ctx.ap.residualSurcharge.toFixed(0)} vermeerdering`,
        });
      }
    }

    // 5. Cash buffer warning
    if (ctx.cash.safeToSpend < 0) {
      items.push({
        color: 'rose',
        title: `Cashbuffer onvoldoende: ${fmtEUR0(ctx.cash.safeToSpend)} tekort`,
        meta: `Reserveer voor BTW (${fmtEUR0(ctx.cash.breakdown.vatRemaining)}), venn.bel. (${fmtEUR0(ctx.cash.breakdown.corpTaxRemaining)}) en sociale bijdr. (${fmtEUR0(ctx.cash.breakdown.socialRemaining)})`,
      });
    }

    return items;
  }

  /* ----- Profile ----- */
  function renderProfile(state) {
    const p = state.profile;
    const root = $('#panel-profile');
    root.innerHTML = `
      <h1 class="panel-title">Profiel</h1>
      <p class="panel-subtitle">De gegevens van je managementvennootschap. Wijzig vrij — alles wordt automatisch herberekend.</p>

      <div class="card">
        <div class="card-head"><span class="icon cyan">${icon('id')}</span><h3>Bedrijf</h3></div>
        <div class="field-row">
          <div class="field"><label>Bedrijfsnaam</label>
            <input type="text" data-p="legalName" value="${esc(p.legalName)}" placeholder="Mijn Management BV"></div>
          <div class="field"><label>BTW-nummer</label>
            <input type="text" data-p="vatNumber" value="${esc(p.vatNumber)}" placeholder="BE0123.456.789"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>BTW-regime</label>
            <select data-p="vatRegime">
              <option value="quarterly" ${p.vatRegime==='quarterly'?'selected':''}>Kwartaal</option>
              <option value="monthly" ${p.vatRegime==='monthly'?'selected':''}>Maandelijks</option>
            </select></div>
          <div class="field"><label>Boekjaar</label>
            <input type="number" data-p="fiscalYear" value="${p.fiscalYear}" min="2020" max="2099"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Oprichtingsjaar</label>
            <input type="number" data-p="foundingYear" value="${p.foundingYear}" min="1980" max="2099"></div>
          <div class="field"><label>Verwachte jaaromzet (excl. BTW)</label>
            <input type="number" data-p="expectedAnnualRevenue" value="${p.expectedAnnualRevenue}" step="1000"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon violet">${icon('user')}</span><h3>Bezoldiging bedrijfsleider</h3></div>
        <div class="field-row">
          <div class="field"><label>Bruto jaarbezoldiging</label>
            <input type="number" data-p="directorSalaryGross" value="${p.directorSalaryGross}" step="500">
            <div class="hint">Minimum ${fmtEUR0(Tax.MIN_DIRECTOR_SALARY)} (geïndexeerd 2026) voor 20% verlaagd tarief</div></div>
          <div class="field"><label>Voordelen alle aard (jaarbasis)</label>
            <input type="number" data-p="directorBenefitsInKind" value="${p.directorBenefitsInKind}" step="100">
            <div class="hint">Mag max. 20% van totale bezoldiging zijn</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon amber">${icon('check')}</span><h3>Voorwaarden 20%-tarief</h3></div>
        <label class="checkbox"><input type="checkbox" data-p="smallCompanyArt124" ${p.smallCompanyArt124?'checked':''}><span class="box"></span>Kleine vennootschap (art. 1:24 WVV)</label>
        <label class="checkbox"><input type="checkbox" data-p="affiliatedHoldingMajority" ${p.affiliatedHoldingMajority?'checked':''}><span class="box"></span>&gt; 50% aandelen in handen van een andere vennootschap</label>
        <label class="checkbox"><input type="checkbox" data-p="isStartupSmall" ${p.isStartupSmall?'checked':''}><span class="box"></span>Kleine startende vennootschap (vrijgesteld voorafbetalingen eerste 3 boekjaren)</label>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon emerald">${icon('coin')}</span><h3>Cash startsaldo</h3></div>
        <div class="field-row">
          <div class="field"><label>Beginsaldo</label>
            <input type="number" data-p="openingCashBalance" value="${p.openingCashBalance}" step="100"></div>
          <div class="field"><label>Op datum</label>
            <input type="date" data-p="openingCashDate" value="${p.openingCashDate}"></div>
        </div>
      </div>

      <div class="hstack" style="margin-top:1rem;">
        <button class="btn danger" id="btn-reset">Alles wissen</button>
      </div>
    `;

    $$('#panel-profile [data-p]').forEach(el => {
      el.addEventListener('change', () => {
        const key = el.dataset.p;
        let val;
        if (el.type === 'checkbox') val = el.checked;
        else if (el.type === 'number') val = parseFloat(el.value) || 0;
        else val = el.value;
        Store.update(s => { s.profile[key] = val; });
        renderAll();
      });
    });

    $('#btn-reset').onclick = () => {
      if (!confirm('Alle gegevens wissen? Dit kan niet ongedaan gemaakt worden.')) return;
      Store.reset();
      renderAll();
      toast('Reset uitgevoerd', 'success');
    };
  }

  /* ----- VAT ----- */
  function renderVat(state, ctx) {
    const root = $('#panel-vat');
    const { vatY } = ctx;
    const today = new Date();

    root.innerHTML = `
      <h1 class="panel-title">BTW ${ctx.year}</h1>
      <p class="panel-subtitle">Output BTW (verkoop) − Input BTW (aftrekbare aankopen). Aangifte ten laatste de 25e van de maand na het kwartaal.</p>

      <div class="qgrid">
        ${vatY.quarters.map(q => {
          const planned = state.vatPaymentsPlanned.find(p => p.quarter === q.quarter);
          const paid = planned && planned.paid;
          const dl = parseEUDate(q.deadline);
          const overdue = !paid && dl < today && q.payable > 0;
          const due = !paid && !overdue && (dl - today) / 86400000 < 30 && q.payable > 0;
          const status = paid ? 'Betaald' : overdue ? 'Te laat' : due ? 'Vervaldag nadert' : 'Open';
          const cls = paid ? 'paid' : overdue ? 'overdue' : due ? 'due' : '';
          const refundCls = q.refund > 0.01 && q.payable < 0.01 ? 'refund' : '';
          return `
          <div class="qcard ${cls} ${refundCls}">
            <div class="qhead">
              <span class="qname">${q.quarter}</span>
              <span class="pill ${paid?'emerald':overdue?'rose':due?'amber':'muted'}">${status}</span>
            </div>
            <div class="qpay">${q.payable > 0 ? fmtEUR0(q.payable) : (q.refund > 0 ? fmtEUR0(q.refund) + ' terug' : '€ 0')}</div>
            <div class="qbreak"><span>Output BTW</span><span>${fmtEUR0(q.outputVat)}</span></div>
            <div class="qbreak"><span>Input BTW</span><span>${fmtEUR0(q.inputVat)}</span></div>
            <div class="qfoot">
              <span>Vervaldag ${q.deadline}</span>
              <label class="checkbox" style="margin:0;">
                <input type="checkbox" data-vatpaid="${q.quarter}" data-amount="${q.payable}" data-deadline="${q.deadline}" ${paid?'checked':''}>
                <span class="box"></span>Betaald
              </label>
            </div>
          </div>`;
        }).join('')}
      </div>

      <div class="card" style="margin-top:1.25rem;">
        <div class="card-head"><span class="icon cyan">${icon('chart')}</span><h3>Output vs. Input per kwartaal</h3></div>
        <div id="chart-vat" class="chart-wrap"></div>
        <div class="legend">
          <span><span class="dot" style="background:#06B6D4"></span>Output BTW</span>
          <span><span class="dot" style="background:#8B5CF6"></span>Input BTW</span>
        </div>
      </div>
    `;

    Charts.barChart($('#chart-vat'), vatY.quarters.map(q => ({
      label: `Q${q.q}`,
      bars: [{ value: q.outputVat, color: '#06B6D4' }, { value: q.inputVat, color: '#8B5CF6' }],
    })));

    $$('[data-vatpaid]').forEach(el => {
      el.addEventListener('change', () => {
        const quarter = el.dataset.vatpaid;
        const amount = parseFloat(el.dataset.amount);
        const deadline = el.dataset.deadline;
        Store.update(s => {
          let p = s.vatPaymentsPlanned.find(x => x.quarter === quarter);
          if (!p) { p = { quarter, dueDate: deadline, amount, paid: false }; s.vatPaymentsPlanned.push(p); }
          p.amount = amount; p.paid = el.checked;
        });
        renderAll();
      });
    });
  }

  /* ----- Corporate tax ----- */
  function renderCorp(state, ctx) {
    const root = $('#panel-corp');
    const { corp, corpWhatIf, ap } = ctx;
    const whatIfSal = state.ui.salaryWhatIf || 50000;
    const winsCurrent = corp.totalCharge < corpWhatIf.totalCharge;

    root.innerHTML = `
      <h1 class="panel-title">Vennootschapsbelasting ${ctx.year}</h1>
      <p class="panel-subtitle">Geschatte aanslag voor aanslagjaar ${ctx.year+1}, met live check op de voorwaarden voor het verlaagd tarief.</p>

      <div class="kpi-grid">
        <div class="kpi ${corp.qualifies?'emerald':'amber'}">
          <div class="lbl">Verwachte aanslag</div>
          <div class="val">${fmtEUR0(corp.tax)}</div>
          <div class="sub">${corp.rateLabel}</div>
        </div>
        <div class="kpi violet">
          <div class="lbl">Belastbare winst</div>
          <div class="val">${fmtEUR0(corp.profitBeforeTax)}</div>
          <div class="sub">na ${fmtEUR0(corp.salary)} bezoldiging + ${fmtEUR0(corp.social)} sociale bijdr.</div>
        </div>
        ${corp.shortfallPenalty > 0 ? `
        <div class="kpi rose">
          <div class="lbl">5% afzonderlijke heffing</div>
          <div class="val">${fmtEUR0(corp.shortfallPenalty)}</div>
          <div class="sub">op tekort bezoldiging (€ ${(Tax.MIN_DIRECTOR_SALARY-corp.salary).toLocaleString('nl-BE')})</div>
        </div>` : ''}
        <div class="kpi amber">
          <div class="lbl">Vermeerdering bij geen voorafbet.</div>
          <div class="val">${fmtEUR0(ap.surchargeBase)}</div>
          <div class="sub">${(Tax.SURCHARGE_RATE*100).toFixed(2)}% × verwachte aanslag</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon ${corp.qualifies?'emerald':'rose'}">${icon('check')}</span><h3>Voorwaarden 20%-tarief</h3></div>
        <ul class="checklist">
          <li class="${corp.conditions.smallCompanyArt124?'ok':'bad'}">
            <span class="marker">${corp.conditions.smallCompanyArt124?'✓':'✗'}</span>
            <div class="body"><strong>Kleine vennootschap (art. 1:24 WVV)</strong>
              <div class="meta">${corp.conditions.smallCompanyArt124 ? 'Zo aangevinkt in profiel.' : 'Profiel: niet aangevinkt — verlaagd tarief niet mogelijk.'}</div></div>
          </li>
          <li class="${corp.conditions.salaryOk?'ok':'bad'}">
            <span class="marker">${corp.conditions.salaryOk?'✓':'✗'}</span>
            <div class="body"><strong>Bezoldiging ≥ ${fmtEUR0(Tax.MIN_DIRECTOR_SALARY)}</strong>
              <div class="meta">Huidig: ${fmtEUR0(corp.salary)} ${corp.conditions.salaryOk ? '— in orde.' : `— tekort van ${fmtEUR0(Tax.MIN_DIRECTOR_SALARY-corp.salary)}.`}</div></div>
          </li>
          <li class="${corp.conditions.notHoldingMajority?'ok':'bad'}">
            <span class="marker">${corp.conditions.notHoldingMajority?'✓':'✗'}</span>
            <div class="body"><strong>≤ 50% aandelen bij andere vennootschap</strong>
              <div class="meta">${corp.conditions.notHoldingMajority?'Geen meerderheid bij holding.':'Profiel: meerderheid bij andere vennootschap.'}</div></div>
          </li>
          <li class="${corp.conditions.bikOk?'ok':'bad'}">
            <span class="marker">${corp.conditions.bikOk?'✓':'✗'}</span>
            <div class="body"><strong>Voordelen alle aard ≤ 20% van totale bezoldiging</strong>
              <div class="meta">VAA ${fmtEUR0(state.profile.directorBenefitsInKind)} op totaal ${fmtEUR0(corp.salary+state.profile.directorBenefitsInKind)} = ${fmtPct(state.profile.directorBenefitsInKind/Math.max(1,corp.salary+state.profile.directorBenefitsInKind))}</div></div>
          </li>
        </ul>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon violet">${icon('split')}</span><h3>Wat als…</h3></div>
        <div class="field" style="max-width:280px;">
          <label>Simuleer bezoldiging</label>
          <input type="number" id="whatif-salary" value="${whatIfSal}" step="500">
        </div>
        <div class="compare">
          <div class="compare-col ${winsCurrent?'win':''}">
            <h4>Huidig — ${fmtEUR0(corp.salary)}</h4>
            <div class="big">${fmtEUR0(corp.totalCharge)}</div>
            <div class="row"><span>Tarief</span><strong>${corp.rateLabel}</strong></div>
            <div class="row"><span>Belastbare winst</span><strong>${fmtEUR0(corp.profitBeforeTax)}</strong></div>
            <div class="row"><span>Aanslag</span><strong>${fmtEUR0(corp.tax)}</strong></div>
            <div class="row"><span>5% heffing</span><strong>${fmtEUR0(corp.shortfallPenalty)}</strong></div>
          </div>
          <div class="compare-col ${!winsCurrent?'win':''}">
            <h4>Simulatie — ${fmtEUR0(whatIfSal)}</h4>
            <div class="big">${fmtEUR0(corpWhatIf.totalCharge)}</div>
            <div class="row"><span>Tarief</span><strong>${corpWhatIf.rateLabel}</strong></div>
            <div class="row"><span>Belastbare winst</span><strong>${fmtEUR0(corpWhatIf.profitBeforeTax)}</strong></div>
            <div class="row"><span>Aanslag</span><strong>${fmtEUR0(corpWhatIf.tax)}</strong></div>
            <div class="row"><span>5% heffing</span><strong>${fmtEUR0(corpWhatIf.shortfallPenalty)}</strong></div>
          </div>
        </div>
        <p class="dim" style="margin-top:0.75rem;font-size:0.85rem;">
          Δ venn.belasting: <strong class="${winsCurrent?'good':'bad'}">${fmtEUR0(corp.totalCharge - corpWhatIf.totalCharge)}</strong>.
          Hou rekening met extra personenbelasting (~50% marginale tarief op ${fmtEUR0(whatIfSal-corp.salary)}) en sociale bijdragen (~${fmtEUR0((whatIfSal-corp.salary)*Tax.SOCIAL_CONTRIB_RATE)}) bij hogere bezoldiging.
        </p>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon cyan">${icon('clock')}</span><h3>Voorafbetalingen</h3></div>
        ${ap.exempt ? `<div class="empty">${ap.note}</div>` : `
        <table class="tbl">
          <thead><tr><th>Code</th><th>Vervaldag</th><th class="right">Tegoed-%</th><th class="right">Bedrag</th><th>Betaald</th></tr></thead>
          <tbody>
            ${['VA1','VA2','VA3','VA4'].map(code => {
              const planned = state.advancePaymentsPlanned.find(p => p.code === code) || { code, dueDate: Tax.vaDueFor(ctx.year)[code], amount: 0, paid: false };
              const reco = ap.recommended.even[code] || 0;
              return `
              <tr>
                <td><strong>${code}</strong></td>
                <td>${planned.dueDate}</td>
                <td class="right">${(Tax.VA_CREDITS[code]*100).toFixed(1)}%</td>
                <td class="right">
                  <input type="number" data-va="${code}" value="${planned.amount}" step="100" placeholder="${reco.toFixed(0)}" style="max-width:120px;">
                </td>
                <td>
                  <label class="checkbox" style="margin:0;">
                    <input type="checkbox" data-va-paid="${code}" ${planned.paid?'checked':''}><span class="box"></span>
                  </label>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr><td colspan="3" class="right dim">Tegoed verzameld</td><td class="right"><strong>${fmtEUR0(ap.creditEarned)}</strong></td><td></td></tr>
            <tr><td colspan="3" class="right dim">Vermeerdering basis</td><td class="right"><strong>${fmtEUR0(ap.surchargeBase)}</strong></td><td></td></tr>
            <tr><td colspan="3" class="right">Resterende vermeerdering</td>
                <td class="right"><strong class="${ap.residualSurcharge<0.5?'good':'bad'}">${fmtEUR0(ap.residualSurcharge)}</strong></td><td></td></tr>
          </tfoot>
        </table>
        <div class="hstack" style="margin-top:0.85rem;">
          <button class="btn sm" id="btn-va-even">Verdeel gelijkmatig (4× ${fmtEUR0(ap.recommended.even.VA1)})</button>
          <button class="btn sm" id="btn-va-front">Front-load (75% in VA1)</button>
          <button class="btn sm ghost" id="btn-va-clear">Reset</button>
        </div>
        `}
      </div>
    `;

    $('#whatif-salary')?.addEventListener('change', e => {
      Store.update(s => { s.ui.salaryWhatIf = parseFloat(e.target.value) || 50000; });
      renderAll();
    });

    $$('[data-va]').forEach(el => {
      el.addEventListener('change', () => {
        const code = el.dataset.va;
        const amt = parseFloat(el.value) || 0;
        Store.update(s => {
          let p = s.advancePaymentsPlanned.find(x => x.code === code);
          if (!p) { p = { code, dueDate: Tax.vaDueFor(ctx.year)[code], amount: 0, paid: false }; s.advancePaymentsPlanned.push(p); }
          p.amount = amt;
        });
        renderAll();
      });
    });
    $$('[data-va-paid]').forEach(el => {
      el.addEventListener('change', () => {
        const code = el.dataset.vaPaid;
        Store.update(s => {
          let p = s.advancePaymentsPlanned.find(x => x.code === code);
          if (!p) { p = { code, dueDate: Tax.vaDueFor(ctx.year)[code], amount: 0, paid: false }; s.advancePaymentsPlanned.push(p); }
          p.paid = el.checked;
        });
        renderAll();
      });
    });

    $('#btn-va-even')?.addEventListener('click', () => {
      Store.update(s => {
        for (const code of ['VA1','VA2','VA3','VA4']) {
          let p = s.advancePaymentsPlanned.find(x => x.code === code);
          if (!p) { p = { code, dueDate: Tax.vaDueFor(ctx.year)[code], amount: 0, paid: false }; s.advancePaymentsPlanned.push(p); }
          p.amount = ap.recommended.even[code];
        }
      });
      renderAll();
    });
    $('#btn-va-front')?.addEventListener('click', () => {
      Store.update(s => {
        for (const code of ['VA1','VA2','VA3','VA4']) {
          let p = s.advancePaymentsPlanned.find(x => x.code === code);
          if (!p) { p = { code, dueDate: Tax.vaDueFor(ctx.year)[code], amount: 0, paid: false }; s.advancePaymentsPlanned.push(p); }
          p.amount = ap.recommended.front[code];
        }
      });
      renderAll();
    });
    $('#btn-va-clear')?.addEventListener('click', () => {
      Store.update(s => { s.advancePaymentsPlanned = []; });
      renderAll();
    });
  }

  /* ----- Social ----- */
  function renderSocial(state, ctx) {
    const root = $('#panel-social');
    const { social } = ctx;
    root.innerHTML = `
      <h1 class="panel-title">Sociale bijdragen</h1>
      <p class="panel-subtitle">Geschat op ${(Tax.SOCIAL_CONTRIB_RATE*100).toFixed(1)}% van de bruto bezoldiging. Effectieve regularisatie volgt 2 jaar later op basis van werkelijk netto belastbaar inkomen.</p>

      <div class="kpi-grid">
        <div class="kpi violet">
          <div class="lbl">Geschatte jaarbijdrage</div>
          <div class="val">${fmtEUR0(social.annual)}</div>
          <div class="sub">op ${fmtEUR0(state.profile.directorSalaryGross)} bezoldiging</div>
        </div>
        <div class="kpi cyan">
          <div class="lbl">Per kwartaal</div>
          <div class="val">${fmtEUR0(social.annual/4)}</div>
          <div class="sub">aftrekbare beroepskost</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon cyan">${icon('clock')}</span><h3>Kwartaalschema</h3></div>
        <table class="tbl">
          <thead><tr><th>Kwartaal</th><th>Vervaldag</th><th class="right">Bedrag</th></tr></thead>
          <tbody>
            ${social.schedule.map(s => `
              <tr><td>${s.quarter}</td><td>${s.dueDate}</td><td class="right">${fmtEUR0(s.amount)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /* ----- Transactions ----- */
  function renderTransactions(state, ctx) {
    const root = $('#panel-transactions');
    const sub = state.ui.activeReviewTab || 'review';
    const unclassified = state.transactions.filter(t => t.category === 'unclassified');

    root.innerHTML = `
      <h1 class="panel-title">Transacties</h1>
      <p class="panel-subtitle">Sleep een CSV-export van Belfius, KBC, BNP, ING of Argenta — of voeg manueel een transactie toe.</p>

      <div class="card">
        <label class="drop" id="drop">
          <input type="file" id="file-input" accept=".csv,text/csv" multiple>
          <div>${icon('upload', 32)}</div>
          <h4>CSV uploaden</h4>
          <p>Sleep hier een bankexport, of klik om te bladeren</p>
        </label>
        <div class="hstack" style="margin-top:0.85rem; justify-content:space-between;">
          <button class="btn primary" id="btn-add-manual">${icon('plus')} Manueel toevoegen</button>
          <span class="dim" style="font-size:0.82rem;">${state.transactions.length} transactie${state.transactions.length===1?'':'s'} totaal</span>
        </div>
      </div>

      <div class="subtabs" style="margin-top:1.5rem;">
        <button class="subtab ${sub==='review'?'active':''}" data-sub="review">Review${unclassified.length?` <span class="badge">${unclassified.length}</span>`:''}</button>
        <button class="subtab ${sub==='all'?'active':''}" data-sub="all">Alles</button>
        <button class="subtab ${sub==='rules'?'active':''}" data-sub="rules">Regels (${state.categorizationRules.length})</button>
      </div>

      <div class="card">
        <div id="tx-list"></div>
      </div>
    `;

    $('#drop').addEventListener('dragover', e => { e.preventDefault(); $('#drop').classList.add('over'); });
    $('#drop').addEventListener('dragleave', () => $('#drop').classList.remove('over'));
    $('#drop').addEventListener('drop', e => {
      e.preventDefault();
      $('#drop').classList.remove('over');
      handleFiles(e.dataTransfer.files);
    });
    $('#file-input').addEventListener('change', e => handleFiles(e.target.files));

    $('#btn-add-manual').addEventListener('click', openManualEntryModal);

    $$('[data-sub]').forEach(b => b.addEventListener('click', () => {
      Store.update(s => { s.ui.activeReviewTab = b.dataset.sub; });
      renderAll();
    }));

    if (sub === 'review') renderReviewList(state);
    else if (sub === 'all') renderAllList(state);
    else renderRulesList(state);
  }

  function renderReviewList(state) {
    const list = state.transactions.filter(t => t.category === 'unclassified')
      .sort((a,b) => (a.date < b.date ? 1 : -1));
    const root = $('#tx-list');
    if (!list.length) {
      root.innerHTML = '<div class="empty"><div class="hi">Niets te reviewen 🎉</div>Alle transacties zijn gecategoriseerd.</div>';
      return;
    }
    root.innerHTML = `
      <table class="tbl">
        <thead><tr>
          <th>Datum</th><th>Tegenpartij</th><th class="right">Bedrag</th>
          <th>Categorie</th><th>Sub</th><th>BTW%</th><th class="right">Aftr.%</th><th></th>
        </tr></thead>
        <tbody>
          ${list.map(t => txRow(t, state, true)).join('')}
        </tbody>
      </table>
    `;
    wireTxRows(state);
  }

  function renderAllList(state) {
    const list = [...state.transactions].sort((a,b) => (a.date < b.date ? 1 : -1));
    const root = $('#tx-list');
    if (!list.length) {
      root.innerHTML = '<div class="empty"><div class="hi">Nog geen transacties</div>Upload een CSV of voeg er manueel toe.</div>';
      return;
    }
    root.innerHTML = `
      <table class="tbl">
        <thead><tr>
          <th>Datum</th><th>Tegenpartij</th><th class="right">Bedrag</th>
          <th>Categorie</th><th>Sub</th><th>BTW%</th><th class="right">Aftr.%</th><th></th>
        </tr></thead>
        <tbody>${list.map(t => txRow(t, state, false)).join('')}</tbody>
      </table>
    `;
    wireTxRows(state);
  }

  function renderRulesList(state) {
    const root = $('#tx-list');
    if (!state.categorizationRules.length) {
      root.innerHTML = '<div class="empty"><div class="hi">Nog geen regels</div>Categoriseer een transactie en kies "Toepassen op alle van deze tegenpartij" om automatisch een regel aan te maken.</div>';
      return;
    }
    root.innerHTML = `
      <table class="tbl">
        <thead><tr><th>Tegenpartij</th><th>Categorie</th><th>Sub</th><th>BTW%</th><th class="right">Aftr.%</th><th></th></tr></thead>
        <tbody>
          ${state.categorizationRules.map(r => `
            <tr>
              <td>${esc(r.counterpartyLabel || r.match.value)}</td>
              <td>${r.apply.category || '–'}</td>
              <td>${r.apply.subCategory || '–'}</td>
              <td>${r.apply.vatRate ?? '–'}</td>
              <td class="right">${fmtPct(r.apply.deductibilityPct)}</td>
              <td><button class="btn sm danger" data-del-rule="${r.id}">Verwijderen</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
    $$('[data-del-rule]').forEach(b => b.addEventListener('click', () => {
      Store.update(s => { s.categorizationRules = s.categorizationRules.filter(r => r.id !== b.dataset.delRule); });
      renderAll();
    }));
  }

  const CAT_OPTIONS = [
    ['unclassified', '— kies —'],
    ['revenue', 'Omzet'],
    ['expense', 'Aftrekbare uitgave'],
    ['non_deductible', 'Niet-aftrekbaar'],
    ['vat_payment', 'BTW-betaling'],
    ['corp_tax_payment', 'Venn.belasting'],
    ['advance_payment', 'Voorafbetaling'],
    ['salary', 'Bezoldiging'],
    ['social_contribution', 'Sociale bijdragen'],
    ['transfer', 'Overschrijving'],
    ['ignore', 'Negeren'],
  ];

  function txRow(t, state, withApplyAll) {
    const subOpts = ['', ...Object.keys(Rules.SUB)].map(k =>
      `<option value="${k}" ${t.subCategory===k?'selected':''}>${k || '—'}</option>`).join('');
    const catOpts = CAT_OPTIONS.map(([v,l]) =>
      `<option value="${v}" ${t.category===v?'selected':''}>${l}</option>`).join('');
    const amountCls = t.amount > 0 ? 'good' : 'dim';
    return `
      <tr data-tid="${t.id}">
        <td>${t.date}</td>
        <td><div>${esc(t.counterparty || '–')}</div>${t.bank ? `<div class="dim" style="font-size:0.72rem;">${t.bank}</div>` : ''}</td>
        <td class="right num ${amountCls}">${fmtEUR(t.amount)}</td>
        <td><select data-f="category">${catOpts}</select></td>
        <td><select data-f="subCategory">${subOpts}</select></td>
        <td><select data-f="vatRate">
          ${[0,6,12,21].map(r => `<option value="${r}" ${(t.vatRate||0)==r?'selected':''}>${r}%</option>`).join('')}
        </select></td>
        <td class="right"><input type="number" data-f="deductibilityPct" value="${((t.deductibilityPct ?? 1)*100).toFixed(0)}" min="0" max="100" step="5" style="max-width:70px;"></td>
        <td class="hstack" style="gap:0.3rem;">
          ${withApplyAll && t.counterpartyKey ? `<button class="btn sm" data-apply-all="${t.id}" title="Maak regel voor deze tegenpartij">→ regel</button>` : ''}
          <button class="btn sm danger ghost" data-del-tx="${t.id}">×</button>
        </td>
      </tr>`;
  }

  function wireTxRows(state) {
    $$('#tx-list tr[data-tid]').forEach(row => {
      const tid = row.dataset.tid;
      row.querySelectorAll('[data-f]').forEach(el => {
        el.addEventListener('change', () => {
          Store.update(s => {
            const t = s.transactions.find(x => x.id === tid);
            if (!t) return;
            const f = el.dataset.f;
            if (f === 'deductibilityPct') t[f] = (parseFloat(el.value) || 0) / 100;
            else if (f === 'vatRate') t[f] = parseInt(el.value);
            else t[f] = el.value || null;
            t.manuallyEdited = true;
            // If sub-category changes, apply defaults
            if (f === 'subCategory' && t.subCategory) {
              const def = Rules.SUB[t.subCategory];
              if (def) {
                t.deductibilityPct = def.ded;
                t.vatRate = def.vat;
              }
            }
            Rules.recomputeVat(t);
          });
          renderAll();
        });
      });
      row.querySelector('[data-del-tx]')?.addEventListener('click', () => {
        Store.update(s => { s.transactions = s.transactions.filter(t => t.id !== tid); });
        renderAll();
      });
      row.querySelector('[data-apply-all]')?.addEventListener('click', () => {
        Store.update(s => {
          const t = s.transactions.find(x => x.id === tid);
          if (!t) return;
          const rule = Rules.createOrUpdateRule(s, t);
          if (rule) Rules.autoClassify(s, s.transactions);
        });
        toast('Regel aangemaakt — toegepast op alle matches', 'success');
        renderAll();
      });
    });
  }

  function openManualEntryModal() {
    const today = toISODate(new Date());
    $('#modal-bg').classList.add('open');
    $('#modal').innerHTML = `
      <h3>Manueel transactie toevoegen</h3>
      <div class="field-row">
        <div class="field"><label>Datum</label><input type="date" id="m-date" value="${today}"></div>
        <div class="field"><label>Bedrag (€)</label><input type="number" id="m-amount" step="0.01" placeholder="100.00"></div>
      </div>
      <div class="field"><label>Tegenpartij / omschrijving</label><input type="text" id="m-cp" placeholder="Bv. Klant XYZ"></div>
      <div class="field-row">
        <div class="field"><label>Categorie</label>
          <select id="m-cat">${CAT_OPTIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>BTW%</label>
          <select id="m-vat">${[0,6,12,21].map(r=>`<option value="${r}" ${r===21?'selected':''}>${r}%</option>`).join('')}</select></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="m-cancel">Annuleren</button>
        <button class="btn primary" id="m-save">Toevoegen</button>
      </div>
    `;
    $('#m-cancel').onclick = () => $('#modal-bg').classList.remove('open');
    $('#m-save').onclick = () => {
      const amount = parseFloat($('#m-amount').value);
      const date = $('#m-date').value;
      const cp = $('#m-cp').value.trim();
      const category = $('#m-cat').value;
      const vatRate = parseInt($('#m-vat').value);
      if (isNaN(amount) || !date) { toast('Vul minstens datum en bedrag in', 'error'); return; }
      const signedAmount = (category === 'expense' || category === 'non_deductible' || category === 'salary'
                          || category === 'social_contribution' || category === 'vat_payment'
                          || category === 'corp_tax_payment' || category === 'advance_payment')
                          ? -Math.abs(amount) : Math.abs(amount);
      const t = {
        id: uid(), date, amount: signedAmount,
        counterparty: cp, counterpartyKey: Parsers.normalizeKey(cp),
        rawDescription: '', bank: 'manual',
        category, subCategory: null, vatRate,
        vatAmount: 0, netAmount: Math.abs(signedAmount), deductibilityPct: 1,
        sourceFile: 'manual', sourceRow: 0, manuallyEdited: true,
      };
      Rules.recomputeVat(t);
      Store.update(s => { s.transactions.push(t); });
      $('#modal-bg').classList.remove('open');
      toast('Transactie toegevoegd', 'success');
      renderAll();
    };
  }

  function handleFiles(files) {
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        Parsers.parseCSV(e.target.result, file.name).then(({ rows, profile }) => {
          if (!rows.length) { toast(`${file.name}: geen rijen herkend`, 'error'); return; }
          // De-dup by (date, amount, counterpartyKey, sourceFile)
          Store.update(s => {
            const existing = new Set(s.transactions.map(t =>
              `${t.date}|${t.amount}|${t.counterpartyKey}|${t.sourceFile}`));
            const fresh = rows.filter(r =>
              !existing.has(`${r.date}|${r.amount}|${r.counterpartyKey}|${r.sourceFile}`));
            s.transactions.push(...fresh);
            const matched = Rules.autoClassify(s, fresh);
            toast(`${fresh.length} nieuwe rijen geïmporteerd uit ${profile.toUpperCase()}, ${matched} auto-geclassificeerd`, 'success');
          });
          renderAll();
        }).catch(err => {
          console.error(err);
          toast(`${file.name}: ${err.message}`, 'error');
        });
      };
      reader.readAsText(file);
    });
  }

  /* ----- Expense advisor ----- */
  function renderAdvisor(state, ctx) {
    const root = $('#panel-advisor');
    const safe = ctx.cash.safeToSpend;
    const m = state.ui.advisor || { restaurant: 0, gift: 0, car_lease: 0, software_saas: 0, home_office: 0 };

    root.innerHTML = `
      <h1 class="panel-title">Uitgaven-adviseur</h1>
      <p class="panel-subtitle">Simuleer geplande uitgaven per categorie. Zie netto kost na aftrek, recupereerbare BTW en impact op je cashbuffer.</p>

      <div class="card">
        <div class="card-head"><span class="icon cyan">${icon('beaker')}</span><h3>Geplande extra uitgaven (deze maand)</h3></div>
        <div class="field-row">
          <div class="field"><label>Restaurant (69%, 12% BTW)</label>
            <input type="number" data-adv="restaurant" value="${m.restaurant}" step="50"></div>
          <div class="field"><label>Geschenken klanten (50%, ≤€125/stuk)</label>
            <input type="number" data-adv="gift" value="${m.gift}" step="50"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Auto / leasing (50%, 21% BTW)</label>
            <input type="number" data-adv="car_lease" value="${m.car_lease}" step="100"></div>
          <div class="field"><label>Software / SaaS (100%, 21% BTW)</label>
            <input type="number" data-adv="software_saas" value="${m.software_saas}" step="50"></div>
        </div>
        <div class="field"><label>Thuiskantoor (30%, 21% BTW)</label>
          <input type="number" data-adv="home_office" value="${m.home_office}" step="50"></div>
      </div>

      <div id="advisor-result"></div>
    `;

    $$('[data-adv]').forEach(el => el.addEventListener('input', () => {
      Store.update(s => {
        s.ui.advisor = s.ui.advisor || {};
        s.ui.advisor[el.dataset.adv] = parseFloat(el.value) || 0;
      });
      renderAdvisorResult(state);
    }));
    renderAdvisorResult(state);
  }

  function renderAdvisorResult(state) {
    const m = state.ui.advisor || {};
    const cats = ['restaurant','gift','car_lease','software_saas','home_office'];
    let totalGross = 0, totalNetCost = 0, totalVatRecov = 0, totalDeductible = 0;
    const rows = cats.map(k => {
      const gross = m[k] || 0;
      const def = Rules.SUB[k];
      const vatRate = def.vat / 100;
      const net = gross / (1 + vatRate);
      const vat = gross - net;
      const vatRecov = vat * def.ded;
      const deductible = net * def.ded;
      const corpSavings = deductible * (state.profile.directorSalaryGross >= Tax.MIN_DIRECTOR_SALARY && state.profile.smallCompanyArt124 ? 0.20 : 0.25);
      const netCost = gross - vatRecov - corpSavings;
      totalGross += gross; totalNetCost += netCost; totalVatRecov += vatRecov; totalDeductible += deductible;
      return { k, gross, net, vat, vatRecov, deductible, corpSavings, netCost, ded: def.ded };
    }).filter(r => r.gross > 0);

    const ctx = computeContext(state, state.profile.fiscalYear);
    const newSafe = ctx.cash.safeToSpend - totalGross;

    const rootR = $('#advisor-result');
    rootR.innerHTML = `
      ${rows.length === 0 ? `
        <div class="card"><div class="empty">Voer hierboven een bedrag in om de impact te zien.</div></div>
      ` : `
      <div class="card">
        <div class="card-head"><span class="icon emerald">${icon('coin')}</span><h3>Resultaat</h3></div>
        <table class="tbl">
          <thead><tr>
            <th>Categorie</th><th class="right">Bruto</th><th class="right">Netto</th>
            <th class="right">BTW recup.</th><th class="right">Aftr. basis</th><th class="right">Belastingbesp.</th><th class="right">Netto kost</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${r.k} <span class="dim">(${(r.ded*100).toFixed(0)}%)</span></td>
              <td class="right num">${fmtEUR(r.gross)}</td>
              <td class="right num">${fmtEUR(r.net)}</td>
              <td class="right num good">${fmtEUR(r.vatRecov)}</td>
              <td class="right num">${fmtEUR(r.deductible)}</td>
              <td class="right num good">${fmtEUR(r.corpSavings)}</td>
              <td class="right num"><strong>${fmtEUR(r.netCost)}</strong></td>
            </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Totaal</strong></td>
              <td class="right num"><strong>${fmtEUR(totalGross)}</strong></td>
              <td class="right num"></td>
              <td class="right num good"><strong>${fmtEUR(totalVatRecov)}</strong></td>
              <td class="right num"><strong>${fmtEUR(totalDeductible)}</strong></td>
              <td class="right num good"></td>
              <td class="right num"><strong>${fmtEUR(totalNetCost)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon ${newSafe<0?'rose':'emerald'}">${icon('shield')}</span><h3>Impact op cashbuffer</h3></div>
        <div class="kpi-grid">
          <div class="kpi cyan">
            <div class="lbl">Huidige veilige besteding</div>
            <div class="val">${fmtEUR0(ctx.cash.safeToSpend)}</div>
          </div>
          <div class="kpi ${newSafe<0?'rose':'emerald'}">
            <div class="lbl">Na deze uitgaven</div>
            <div class="val">${fmtEUR0(newSafe)}</div>
            <div class="sub">${newSafe<0 ? '⚠️ Cashbuffer wordt negatief' : 'Buffer blijft gezond'}</div>
          </div>
          <div class="kpi violet">
            <div class="lbl">Effectieve kost</div>
            <div class="val">${fmtPct(totalGross>0?totalNetCost/totalGross:0)}</div>
            <div class="sub">van ${fmtEUR0(totalGross)} bruto blijft ${fmtEUR0(totalNetCost)} netto</div>
          </div>
        </div>
      </div>`}
    `;
  }

  /* ----- Year-end summary ----- */
  function renderYearEnd(state, ctx) {
    const root = $('#panel-yearend');
    const { vatY, corp, ap, social, cash } = ctx;
    const totalTax = corp.totalCharge + vatY.totalPayable + social.annual;
    const actions = buildActionItems(state, ctx);

    root.innerHTML = `
      <h1 class="panel-title">Jaareinde projectie ${ctx.year}</h1>
      <p class="panel-subtitle">Alle cijfers samen geprojecteerd tot 31 december, met concrete acties voor het einde van het boekjaar.</p>

      <div class="kpi-grid">
        <div class="kpi cyan">
          <div class="lbl">Omzet</div>
          <div class="val">${fmtEUR0(corp.revenueNet)}</div>
        </div>
        <div class="kpi violet">
          <div class="lbl">Aftrekbare kosten</div>
          <div class="val">${fmtEUR0(corp.deductibleExpensesNet)}</div>
        </div>
        <div class="kpi emerald">
          <div class="lbl">Bezoldiging + sociale</div>
          <div class="val">${fmtEUR0(corp.salary + corp.social)}</div>
        </div>
        <div class="kpi amber">
          <div class="lbl">Belastbare winst</div>
          <div class="val">${fmtEUR0(corp.profitBeforeTax)}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon amber">${icon('coin')}</span><h3>Totale belasting</h3></div>
        <table class="tbl">
          <tbody>
            <tr><td>BTW (4 kwartalen)</td><td class="right num">${fmtEUR(vatY.totalPayable)}</td></tr>
            <tr><td>Vennootschapsbelasting (${corp.rateLabel})</td><td class="right num">${fmtEUR(corp.tax)}</td></tr>
            ${corp.shortfallPenalty>0 ? `<tr><td>5% afzonderlijke heffing op tekort bezoldiging</td><td class="right num bad">${fmtEUR(corp.shortfallPenalty)}</td></tr>` : ''}
            <tr><td>Sociale bijdragen (zelfstandige bedrijfsleider)</td><td class="right num">${fmtEUR(social.annual)}</td></tr>
            ${ap.residualSurcharge>0.5 ? `<tr><td>Vermeerdering (geen voorafbetalingen)</td><td class="right num bad">${fmtEUR(ap.residualSurcharge)}</td></tr>` : ''}
          </tbody>
          <tfoot>
            <tr><td><strong>Totaal</strong></td><td class="right num"><strong>${fmtEUR(totalTax + (ap.residualSurcharge||0))}</strong></td></tr>
          </tfoot>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon emerald">${icon('shield')}</span><h3>Cash projectie 31/12</h3></div>
        <div class="kpi-grid">
          <div class="kpi cyan">
            <div class="lbl">Verwachte eindsaldo</div>
            <div class="val">${fmtEUR0(cash.lastBalance)}</div>
          </div>
          <div class="kpi violet">
            <div class="lbl">Reserveringen</div>
            <div class="val">${fmtEUR0(cash.totalReserved)}</div>
            <div class="sub">BTW + venn.bel. + sociale</div>
          </div>
          <div class="kpi ${cash.safeToSpend<0?'rose':'emerald'}">
            <div class="lbl">Vrij besteedbaar</div>
            <div class="val">${fmtEUR0(cash.safeToSpend)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="icon amber">${icon('flag')}</span><h3>Actiepunten tot 31/12</h3></div>
        ${actions.length === 0
          ? '<div class="empty">Geen acties open. ✨</div>'
          : `<ol class="actions">${actions.map((a,i)=>`
              <li class="${a.color}">
                <span class="num">${i+1}</span>
                <div class="body"><strong>${a.title}</strong><div class="meta">${a.meta}</div></div>
              </li>`).join('')}</ol>`}
      </div>
    `;
  }

  /* ----- Render orchestration ----- */
  function renderAll() {
    const state = Store.get();
    const yr = state.profile.fiscalYear;
    const ctx = computeContext(state, yr);

    renderTopbar(state);
    renderTabs(state);

    // Hide all
    $$('.panel').forEach(p => p.hidden = true);
    const active = $(`#panel-${state.ui.activeTab}`);
    if (active) active.hidden = false;

    switch (state.ui.activeTab) {
      case 'overview': renderOverview(state, ctx); break;
      case 'transactions': renderTransactions(state, ctx); break;
      case 'vat': renderVat(state, ctx); break;
      case 'corp': renderCorp(state, ctx); break;
      case 'social': renderSocial(state, ctx); break;
      case 'advisor': renderAdvisor(state, ctx); break;
      case 'yearend': renderYearEnd(state, ctx); break;
      case 'profile': renderProfile(state); break;
    }
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  function icon(name, size=14) {
    const ICONS = {
      chart: '<path d="M3 3v18h18M7 14l4-4 4 4 5-5"/>',
      flag: '<path d="M4 22V4M4 4h12l-2 4 2 4H4"/>',
      id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2"/><path d="M14 10h4M14 14h2"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
      check: '<polyline points="20 6 9 17 4 12"/>',
      coin: '<circle cx="12" cy="12" r="9"/><path d="M9 9h4a2 2 0 010 4H9m0 0v4m0-8V7"/>',
      clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>',
      split: '<path d="M3 12h18M9 6l-6 6 6 6M15 6l6 6-6 6"/>',
      upload: '<path d="M12 3v14M5 10l7-7 7 7M5 21h14"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      beaker: '<path d="M9 3v6L4 21h16L15 9V3M9 3h6"/>',
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }

  return { renderAll, toast };
})();

/* ============================================================
   App — bootstrap
============================================================ */
const App = (() => {
  function init() {
    Store.init();

    // Topbar menu
    $('#btn-menu').addEventListener('click', e => {
      e.stopPropagation();
      $('#topbar-menu').classList.toggle('open');
    });
    document.addEventListener('click', () => $('#topbar-menu').classList.remove('open'));

    $('#btn-export').addEventListener('click', () => {
      const json = Store.exportJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `btax-backup-${toISODate(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Store.update(s => { s.ui.lastBackup = new Date().toISOString(); });
      UI.toast('Backup gedownload', 'success');
    });

    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          Store.importJson(ev.target.result);
          UI.toast('Backup geïmporteerd', 'success');
          UI.renderAll();
        } catch (err) {
          UI.toast('Ongeldig JSON-bestand', 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // Modal close on backdrop
    $('#modal-bg').addEventListener('click', e => {
      if (e.target === $('#modal-bg')) $('#modal-bg').classList.remove('open');
    });

    // Console hook for verification
    window.__btax = { Store, Tax, Parsers, Rules, Projection, UI };

    UI.renderAll();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
