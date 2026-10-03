import { atLevel, combatResult, interpolate, modifiedStat } from './calc.mjs';
import { buffIssues, resolveBuffs } from './team.mjs';

export function enemyActions(raidData, enemy) {
  if (!enemy?.character) return [];
  return (enemy.character.Skills ?? []).map(key => ({ key, skill: raidData.enemySkills[key] })).filter(e => e.skill && e.skill.Type !== 'Passive');
}

export function attackFromEnemy(character, level, skill, effect, target, calculated, data, bonuses = [], sourceBonuses = []) {
  const source = { ...character, SquadType: 'Main', StreetBattleAdaptation: 2, OutdoorBattleAdaptation: 2, IndoorBattleAdaptation: 2 };
  const stats = { AttackPower: interpolate(character.AttackPower1 ?? 0, character.AttackPower100 ?? character.AttackPower1 ?? 0, level),
    MaxHP: interpolate(character.MaxHP1, character.MaxHP100, level), DefensePower: interpolate(character.DefensePower1, character.DefensePower100, level),
    HealPower: 0, AccuracyPoint: character.AccuracyPoint ?? 0, CriticalPoint: character.CriticalPoint ?? 0,
    CriticalChanceRate: 0, CriticalDamageRate: character.CriticalDamageRate ?? 20000,
    StabilityPoint: character.StabilityPoint ?? 0, StabilityRate: character.StabilityRate ?? 2000, DefensePenetration: 0,
    EnhanceExDamageRate: 10000, EnhanceBasicsDamageRate: 10000, DamageRatio: 10000, DamageRatio2: 10000 };
  for (const element of ['Explosion','Pierce','Mystic','Sonic']) stats[`Enhance${element}Rate`] = 10000;
  for (const [stat,value] of Object.entries(stats)) stats[stat] = modifiedStat(value,stat,sourceBonuses);
  const targetStats = Object.fromEntries(Object.entries(calculated.stats).map(([stat, value]) => [stat, modifiedStat(value, stat, bonuses, data.limits)]));
  const scale = Array.isArray(effect.Scale?.[0]) ? effect.Scale[0] : effect.Scale;
  return combatResult(source, {}, data, skill, { ...effect, Scale: scale }, 1, {
    armor: target.ArmorType, terrain: 'Street', level: calculated.build.level, defense: targetStats.DefensePower,
    critResist: targetStats.CriticalChanceResistPoint, critDmgResist: targetStats.CriticalDamageResistRate / 100,
    evasion: targetStats.DodgePoint, skillType: skill.Type, calculatedStudent: { build: { level, weaponStars: 0 }, stats, notes: [] }, assumeCondition: false });
}

export class BattleHealth {
  constructor(members, initialContexts, data) {
    this.data = data; this.members = members; this.debuffs = []; this.order = 0;
    this.units = new Map(members.filter(m => m.student.SquadType === 'Main').map(m => {
      const max = initialContexts(m).calculatedStudent.stats.MaxHP;
      return [m.student.Id, { hp: max, max, shields: [], deadAt: null }];
    }));
  }
  alive(id) { return !this.units.has(id) || this.units.get(id).deadAt === null; }
  lowest() { return [...this.units].filter(([,u]) => u.deadAt === null).sort((a,b) => a[1].hp / a[1].max - b[1].hp / b[1].max)[0]?.[0]; }
  bonuses(id, time) { return resolveBuffs(this.debuffs.filter(b => b.targetId === id), time).bonuses; }
  shield(unit, time) { unit.shields = unit.shields.filter(s => s.end > time && s.value > 0); return unit.shields.reduce((sum,s) => sum + s.value,0); }
  hurt(id, damage, time) {
    const u = this.units.get(id); if (!u || u.deadAt !== null) return 0;
    this.shield(u,time); let left = damage;
    for (const s of u.shields) { const used = Math.min(s.value,left); s.value -= used; left -= used; }
    const taken = Math.min(u.hp,left); u.hp -= taken;
    if (u.hp <= 0) u.deadAt = time;
    return taken;
  }
  recover(id, value, time, shieldDuration = 0, sourceId) {
    const u = this.units.get(id); if (!u || u.deadAt !== null) return 0;
    if (shieldDuration) {
      u.shields = u.shields.filter(s => s.sourceId !== sourceId);
      u.shields.push({ value, end: time + shieldDuration, sourceId }); return value;
    }
    const recovered = Math.min(value, u.max - u.hp); u.hp += recovered; return recovered;
  }
  debuff(id, effect, skill, time, duration, label) {
    if (buffIssues(effect,String(id).startsWith('boss-')?'Enemy':'Ally').length || effect.Condition) return false;
    this.debuffs.push({ targetId:id,id:`enemy-${this.order}`,side:'Ally',type:`Enemy-${skill.Type}`,channel:effect.Channel,
      stat:effect.Stat,amount:atLevel(effect.Value[0],1),order:this.order++,start:time,end:duration > 0 ? time + duration : Infinity,label });
    return true;
  }
  snapshot(time) { return Object.fromEntries([...this.units].map(([id,u]) => [id,{ hp:u.hp,max:u.max,shield:this.shield(u,time),deadAt:u.deadAt }])); }
}
