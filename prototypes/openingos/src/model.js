// Fixture-only state for comparing three designs, not production business logic.
export const concepts = [
  { id: 'scene', name: 'Opening scene', eyebrow: '01 / A PLACE TO BEGIN', title: 'Your opening,\ntaking shape.', description: 'Walk into your next chapter. Every piece of equipment, every decision, in one place.' },
  { id: 'routes', name: 'Price routes', eyebrow: '02 / EVERY COST, CONNECTED', title: 'Follow the\nreal price.', description: 'The number on the quote is only the beginning. See exactly where your money goes.' },
  { id: 'workbench', name: 'Purchasing workbench', eyebrow: '03 / ROOM TO THINK', title: 'Everything\non the table.', description: 'Your plans, your suppliers, your next move. A little less chasing. A lot more opening.' },
];
export const initialProject = { name: 'Northside café', budget: 12000, date: '2026-10-12', city: 'Amsterdam', scope: 'Atlas 2G espresso machine, delivery and installation', notes: 'Ground-floor access. Water connection ready. Confirm electrical requirements.' };
export const vendors = [
  { id: 'elm', name: 'Elm Supply', short: 'Elm', base: 7950, delivery: 0, installation: 0, date: '2026-10-06', version: 1, color: '#e65745', status: 'Complete', note: 'Delivery and installation included. 12-month parts and labour warranty.' },
  { id: 'harbor', name: 'Harbor Equipment', short: 'Harbor', base: 7500, delivery: 600, installation: 400, date: '2026-10-08', version: 1, color: '#4c68d7', status: 'Complete', note: 'Ground-floor delivery €600. Installation and commissioning €400.' },
  { id: 'morrow', name: 'Morrow Coffee', short: 'Morrow', base: 7400, delivery: null, installation: null, date: null, version: 1, color: '#287f73', status: 'Missing terms', note: 'Machine-only price. Delivery, installation and ready date not confirmed.' },
  { id: 'kindred', name: 'Kindred Commercial', short: 'Kindred', base: 8200, delivery: 300, installation: 250, date: '2026-10-09', version: 1, color: '#88578e', status: 'Complete', note: 'Exact model. Delivery €300, installation €250.' },
  { id: 'avenue', name: 'Avenue Coffee Co.', short: 'Avenue', base: 7900, delivery: 200, installation: 400, date: '2026-10-19', version: 1, color: '#805838', status: 'Late arrival', note: 'Exact model, but arrival is after the sample opening date.' },
  { id: 'field', name: 'Field & Form', short: 'Field', base: 6900, delivery: 200, installation: 300, date: '2026-10-07', version: 1, color: '#716a61', status: 'Different model', note: 'Atlas 1G, not the requested two-group model. Excluded from comparison.' },
];
export const money = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
export const shortDate = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Unconfirmed';
export function total(quote) {
  return quote.delivery === null || quote.installation === null ? null : quote.base + quote.delivery + quote.installation;
}
export function quoteFor(id, revised = false) {
  const quote = vendors.find(vendor => vendor.id === id) ?? vendors[0];
  return revised && quote.id === 'morrow' ? { ...quote, delivery: 350, installation: 450, date: '2026-10-10', version: 2, status: 'Complete', note: 'Revised fixture reply confirms €350 delivery and €450 installation. Total €8,200.' } : quote;
}
export function canSelect(quote) { return total(quote) !== null && quote.status !== 'Different model'; }
export function forecast(selection) { return { selected: selection ? total(selection) : 0, committed: 0, paid: 0 }; }
export const demoAnswers = {
  difference: 'Elm totals €7,950, including delivery and installation. Harbor totals €8,500: €7,500 + €600 + €400. Elm is €550 lower for the same confirmed scope. All amounts are illustrative, tax-inclusive fixture prices.',
  missing: 'Morrow’s €7,400 is machine-only. Delivery, installation and the ready date are unknown in v1. Open the supplier conversation to approve a clarification, then simulate a revised reply. I have not contacted anyone.',
  fit: 'The brief says ground-floor access and a ready water connection. Electrical supply and final site fit are not verified. Ask the supplier before committing. The café image is illustrative, not a measured layout.',
  cheaper: 'Morrow has the lowest headline price, but its original quote is incomplete. Elm has the lowest complete exact-model total at €7,950. Field & Form is a different model, so it is not an equivalent cheaper option.',
  deadline: 'Elm’s fixture ready date is 6 October; Harbor’s is 8 October. Both precede the sample 12 October opening. These are not live availability guarantees. Use Recovery to try a delivery-change scenario.',
};
export function answerQuestion(question, revised = false) {
  const q = question.trim().toLowerCase();
  // Deliberately narrow fixture matching. This is not a model or a security boundary.
  if (/weather|poem|bitcoin|politic|recipe|code|travel|joke|ignore.*instruction/.test(q)) return { kind: 'refused', text: 'I can only help with this OpeningOS purchasing and equipment project. I can’t handle that request. No action was taken.' };
  if (/morrow|missing|unknown/.test(q)) return { kind: 'answer', text: revised ? 'Morrow v2 confirms delivery €350 and installation €450. Its total is €8,200, ready 10 October. The original €7,400 machine-only quote remains available in version history.' : demoAnswers.missing };
  if (/cheaper|lowest|best price/.test(q)) return { kind: 'answer', text: demoAnswers.cheaper };
  if (/difference|550|harbor|compare|why elm/.test(q)) return { kind: 'answer', text: demoAnswers.difference };
  if (/fit|electric|water|install/.test(q)) return { kind: 'answer', text: demoAnswers.fit };
  if (/date|deadline|late|delivery/.test(q)) return { kind: 'answer', text: demoAnswers.deadline };
  return { kind: 'unavailable', text: 'This scripted prototype can explain the price difference, missing terms, site fit and delivery dates. Other supported OpeningOS questions will need the real assistant. No action was taken.' };
}
