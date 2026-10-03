import { atLevel } from './calc.mjs';

// Since the global 2026-08-18 update: five initial positions, three visible cards.
export function skillDeck(ids, startingOrder = []) {
  const order = [...new Set([...startingOrder.filter(id => ids.includes(id)).slice(0, 5), ...ids])];
  return { hand: order.slice(0, 3), queue: order.slice(3) };
}

export function rotateSkill(deck, id) {
  const slot = deck.hand.indexOf(id);
  if (slot < 0) return false;
  deck.queue.push(id);
  deck.hand[slot] = deck.queue.shift();
  return true;
}

export function removeSkill(deck, id) {
  deck.queue = deck.queue.filter(x => x !== id);
  const slot = deck.hand.indexOf(id);
  if (slot >= 0) {
    const next = deck.queue.shift();
    if (next === undefined) deck.hand.splice(slot, 1); else deck.hand[slot] = next;
  }
}

export function exCost(skill, level, modifier) {
  const base = atLevel(skill.Cost, level);
  if (!modifier || modifier.uses <= 0) return base;
  return Math.max(0, modifier.type === 'Coefficient' ? Math.ceil(base * (1 + modifier.value / 10000)) : base + modifier.value);
}

export function maxCost(members, prepared) {
  return 10 + members.filter(m => m.student.SquadType === 'Support' && prepared.get(m.student.Id).build.weaponStars >= 4).length * .5;
}

// This profile is explicit: ExtraSkills on other students can be alternatives,
// summons or transformed normals and must not be inferred to be follow-up EXs.
export function focusProfile(student) {
  if (student.Id !== 10086) return null;
  const extra = student.Skills.Ex?.ExtraSkills;
  if (extra?.length !== 3 || extra.some(s=>s.Type !== 'Ex' || s.Cost.some(c=>c!==0))) return null;
  return { window: Number(student.Skills.Ex.Desc.match(/\((\d+)초간\)/)?.[1] ?? 10), keys: extra.map((s,i)=>`Ex:${i}`) };
}

export function firstImpact(skill, effect) {
  return (effect?.HitFrames?.[0] ?? effect?.ApplyFrame ?? skill?.Duration ?? 30) / 30;
}
