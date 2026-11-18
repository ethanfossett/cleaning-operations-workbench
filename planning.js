import { dollarsToCents, estimate, InputError, requiredText } from './pricing.js';

// Duration and capacity are person-time. A two-person crew on site for two
// hours consumes 240 labor minutes.
export const planningGroups = [
  { title: 'Customer acquisition', fields: [
    { key: 'monthlyLeads', label: 'Leads per month', min: 0, max: 100000 },
    { key: 'leadCostCents', label: 'Cost per lead ($)', money: true },
    { key: 'firstCleanPercent', label: 'Leads that book a first clean (%)', min: 0, max: 100 },
    { key: 'recurringPercent', label: 'First-clean customers who become recurring (%)', min: 0, max: 100 },
    { key: 'retentionMonths', label: 'Average recurring retention (months)', min: 1, max: 120 },
    { key: 'visitsPerMonth', label: 'Repeat visits per recurring customer per month', min: 1, max: 31 },
  ] },
  { title: 'First clean', fields: [
    { key: 'firstPriceCents', label: 'First clean price ($)', money: true },
    { key: 'firstLaborMinutes', label: 'Labor minutes per first clean', min: 1, max: 10080 },
    { key: 'firstSuppliesCents', label: 'Supplies per first clean ($)', money: true },
  ] },
  { title: 'Repeat visit', fields: [
    { key: 'repeatPriceCents', label: 'Repeat visit price ($)', money: true },
    { key: 'repeatLaborMinutes', label: 'Labor minutes per repeat visit', min: 1, max: 10080 },
    { key: 'repeatSuppliesCents', label: 'Supplies per repeat visit ($)', money: true },
  ] },
  { title: 'Labor and capacity', fields: [
    { key: 'laborHourCents', label: 'Labor cost per person-hour ($)', money: true },
    { key: 'monthlyCrewHours', label: 'Person-hours available per month', min: 0, max: 100000 },
  ] },
];

const sampleScope = { squareFeet: 1000, bathrooms: 2 };
export const planningDefaults = Object.freeze({
  monthlyLeads: 20,
  leadCostCents: 1500,
  firstCleanPercent: 25,
  recurringPercent: 40,
  retentionMonths: 6,
  visitsPerMonth: 2,
  firstPriceCents: estimate({ ...sampleScope, service: 'deep' }).totalCents,
  firstLaborMinutes: 180,
  firstSuppliesCents: 1200,
  repeatPriceCents: estimate({ ...sampleScope, service: 'standard' }).totalCents,
  repeatLaborMinutes: 120,
  repeatSuppliesCents: 700,
  laborHourCents: 2400,
  monthlyCrewHours: 100,
});

const demoScenarios = [
  { name: 'Sample baseline', ...planningDefaults },
  { name: 'Sample higher lead volume', ...planningDefaults, monthlyLeads: 40, leadCostCents: 1800 },
];

export function planningFormValues(scenario = planningDefaults) {
  const values = { name: scenario.name ?? '' };
  for (const field of planningGroups.flatMap(group => group.fields)) {
    values[field.key] = field.money ? (scenario[field.key] / 100).toFixed(2) : String(scenario[field.key]);
  }
  return values;
}

export function readPlanningForm(fields) {
  const scenario = { name: requiredText(fields.name, 'Scenario name') };
  for (const { key, label, min, max, money } of planningGroups.flatMap(group => group.fields)) {
    if (money) {
      scenario[key] = dollarsToCents(fields[key], label);
      continue;
    }
    const raw = typeof fields[key] === 'string' ? fields[key].trim() : '';
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
      throw new InputError(label + ' must be a whole number from ' + min + ' to ' + max + '.');
    }
    scenario[key] = value;
  }
  return scenario;
}

export function openPlanning(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS planning_scenarios (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      assumptions TEXT NOT NULL CHECK (json_valid(assumptions))
    ) STRICT;
  `);
  const rows = db.prepare('SELECT * FROM planning_scenarios ORDER BY id');
  const byId = db.prepare('SELECT * FROM planning_scenarios WHERE id = ?');
  const insert = db.prepare('INSERT INTO planning_scenarios (name, assumptions) VALUES (?, ?)');
  const update = db.prepare('UPDATE planning_scenarios SET name = ?, assumptions = ? WHERE id = ?');

  function unpack(row) {
    return row && { ...JSON.parse(row.assumptions), id: row.id, name: row.name };
  }

  return {
    list: () => rows.all().map(unpack),
    find: id => unpack(byId.get(id)),
    save(scenario, id) {
      const { name, ...assumptions } = scenario;
      const data = JSON.stringify(assumptions);
      if (id === undefined) return Number(insert.run(name, data).lastInsertRowid);
      return update.run(name, data, id).changes ? id : undefined;
    },
    seedDemo() {
      // Demo mode starts with a fresh database. The conditional also keeps
      // reopening the same demo fixture from duplicating its scenarios.
      const seed = db.prepare(`INSERT INTO planning_scenarios (id, name, assumptions)
        VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`);
      demoScenarios.forEach(({ name, ...assumptions }, index) =>
        seed.run(index + 1, name, JSON.stringify(assumptions)));
    },
  };
}
