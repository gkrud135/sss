import { applyStudentBonuses, atLevel, combatResult, skillOptions } from './calc.mjs';
import { prepareTeam, raidEnemy, teamContext } from './team.mjs';
import { attackFromEnemy, BattleHealth } from './battle.mjs';
import { randomTargets } from './boss-random.mjs';
import { exCost, focusProfile, maxCost, removeSkill, rotateSkill, skillDeck } from './rules.mjs';

export const CASES = [{ key: 'mean', label: '평균', color: '#00a7de' },
  { key: 'lucky', label: '운 좋은 경우 · 상위 5% 추정', color: '#bd82f0' },
  { key: 'ceiling', label: '이론 고점', color: '#d5a14c' }];

export function phaseProfile(raidData, raid, difficulty, selectedEnemy, terrain, armor) {
  if (!raid) return [{ name: '1페이즈', hp: 1000000, enemy: selectedEnemy, wait: 0, carry: false }];
  const enemies = raid.EnemyList[difficulty].map(id => raidData.enemies[String(id)]).filter(e => !e.IsNPC);
  let targets = [selectedEnemy.character];
  if (['shirokuro', 'hovercraft'].includes(raid.PathName)) targets = enemies.filter(e => e.Rank === 'Boss');
  if (raid.PathName === 'kaiten') {
    const rangers = enemies.find(e => e.Rank === 'Elite'), robot = enemies.find(e => e.Rank === 'Boss');
    if (rangers && robot) targets = [rangers, robot]; // One shared HP pool for the rangers.
  }
  const phases = [];
  for (const target of targets) {
    const enemy = raidEnemy(raidData, raid, difficulty, target.Id, terrain, armor);
    let remaining = enemy.hp;
    const thresholds = (target.PhaseChange ?? []).filter(p => p.Trigger === 'HPUnder' && p.Argument > 0 && p.Argument < enemy.hp)
      .map(p => p.Argument).sort((a, b) => b - a);
    for (const threshold of [...new Set(thresholds), 0]) {
      phases.push({ name: `${phases.length + 1}페이즈 · ${target.Name}`, hp: remaining - threshold, enemy,
        wait: 0, carry: threshold > 0, received: 100, clearDebuffs: threshold === 0 });
      remaining = threshold;
    }
  }
  return phases;
}

export function normalTiming(student) {
  const f = student.Skills.Normal?.Frames ?? {};
  return { interval: Math.max(.1, ((f.AttackIngDuration ?? 30) + (f.AttackBurstRoundOverDelay ?? 30)) / 30),
    first: ((f.AttackEnterDuration ?? 0) + (f.AttackStartDuration ?? 30)) / 30,
    reload: (f.AttackReloadDuration ?? 60) / 30,
    rounds: Math.max(1, Math.floor((student.AmmoCount ?? 1) / (student.AmmoCost ?? 1))) };
}

export function publicInterval(skill) {
  const match = (skill?.Desc ?? '').match(/(\d+(?:\.\d+)?)초마다/);
  return match ? Number(match[1]) : 0;
}

// Three analytic paths on a 0.1-second clock; no random samples or server work.
export function simulateTactic({ members, data, phases, sequence = [], duration = 180, initialCost = 0, repeat = true, mode = 'sequence', cycle = 30,
  settings = {}, corrections = {}, prepared = prepareTeam(members, data), caseKeys = CASES.map(c => c.key),
  enemyPlan = [], raidData, incomingMode = 'mean', recordTimeline = true, startingOrder = [] }) {
  if (!members.length || !phases.length || phases.some(p => !Number.isFinite(p.hp) || p.hp <= 0)) throw new Error('팀과 양수인 페이즈 HP를 설정하세요.');
  duration = Math.max(1, Math.min(600, Number(duration) || 180));
  const ready = members.map(m => ({ ...m, entries: skillOptions(m.student, prepared.get(m.student.Id).build),
    focus: focusProfile(m.student), timing: { ...normalTiming(m.student), ...(settings[m.student.Id] ?? {}) } }));
  const actions = sequence.map((action, index) => {
    const member = ready.find(m => m.student.Id === action.studentId), entry = member?.entries.find(e => e.key === action.key);
    return member && entry ? { ...action, index, member, entry, level: member.build.skills[entry.parent ?? entry.key] ?? 1 } : null;
  }).filter(Boolean);
  const warnings = new Set();
  if (sequence.length !== actions.length) warnings.add('편성에서 빠진 학생의 행동은 제외했습니다.');
  const totalHP = phases.reduce((sum, p) => sum + p.hp, 0);
  const costCap = maxCost(members, prepared);
  const enemySchedule = enemyPlan.flatMap((action,index) => {
    const interval = Math.max(.1, Number(action.interval) || duration + 1), start = Math.max(0, Number(action.time) || 0), result = [];
    for (let round=0; round<=Math.ceil(duration/interval); round++) {
      const at=start+round*interval; if (at>duration || round && !action.repeat) break;
      result.push({...action,at,index});
    }
    return result;
  }).sort((a,b)=>a.at-b.at || a.index-b.index);
  const scheduled = mode === 'timeline' ? actions.flatMap(action => {
    const copies = [];
    const start = Math.max(0, Number(action.earliest) || 0), interval = Math.max(1, Number(cycle) || 30);
    for (let round = 0; round <= Math.ceil(duration / interval); round++) {
      const at = start + round * interval;
      if (at > duration || round && !repeat) break;
      copies.push({ ...action, at, actionId: `${action.index}-${round}` });
    }
    return copies;
  }).sort((a, b) => a.at - b.at || a.index - b.index) : [];
  const paths = CASES.filter(c => caseKeys.includes(c.key)).map(({ key }) => {
    let phase = 0, progress = 0, applied = 0, mean = 0, variance = 0, peak = 0, lastMetric = 0;
    let cost = Math.max(0, Math.min(costCap, initialCost)), cursor = 0, castingUntil = 0, pausedUntil = 0, epoch = 0;
    const deck = skillDeck(ready.map(m => m.student.Id), startingOrder), costModifiers = new Map(), costEffects = [];
    const forms = new Map();
    let damageCache = new Map();
    let contexts = new Map(), nextBoundary = Infinity;
    const completions = [], timeline = [], events = [], shots = [], records = [], contributions = new Map(), recovery = [], enemyEffects = [];
    let health = null, enemyCursor = 0, wipeTime = null;
    const mechanicStates=[];
    const timers = ready.map(m => ({ member: m, normal: m.student.SquadType === 'Main' ? m.timing.first : Infinity,
      public: /전투 시작 시/.test(m.student.Skills.Public?.Desc ?? '') ? 0 : m.timing.publicInterval ?? publicInterval(m.student.Skills.Public), busy: 0, rounds: 0,
      opening: /전투 시작 시/.test(m.student.Skills.Public?.Desc ?? '') }));
    for (const m of ready) for (const entry of prepared.get(m.student.Id).skills) {
      if (entry.type === 'ExtraPassive' && entry.skill.Effects.every(e => e.Type === 'Buff' && e.Target?.includes('Self') && e.Target.includes('AllyMain') && e.Target.includes('AllySupport') && !e.Duration && !e.Condition) && !entry.skill.Condition)
        records.push({ enabled: true, skillId: entry.id, eventId: `aura-${m.student.Id}`, time: -1, order: -1 });
      else if (entry.type === 'ExtraPassive' && m.student.Id === 10017) {
        const stacks = 1 + Math.min(3, ready.filter(a => a.student.Id !== m.student.Id && a.student.School === m.student.School).length);
        records.push({enabled:true,skillId:entry.id,eventId:`aura-${m.student.Id}`,time:-1,order:-1,stacks});
      }
      else if (entry.type === 'ExtraPassive' && !m.focus && !(/EX 스킬.*(?:사용 시|지속되는 동안)/.test(entry.skill.Desc ?? '') && entry.skill.Effects.every(e=>e.Type==='Buff'&&!e.Condition))) warnings.add(`${m.student.Name}: 조건부 서브 스킬은 자동 발동하지 않습니다. 필요하면 행동에 추가하세요.`);
    }
    const invalidate = () => { contexts.clear(); damageCache.clear(); nextBoundary = Infinity; };
    let time = 0;
    const endFocus = (id, cause) => {
      if (!forms.has(id)) return;
      forms.delete(id);rotateSkill(deck,id);costModifiers.delete(id);
      for (const r of records) if (r.focusId === id) r.endedAt = time;
      invalidate();events.push({time,type:'form-end',studentId:id,label:cause,hand:[...deck.hand],nextSkillKey:'Ex'});
    };
    const currentEntry = action => {
      const form=forms.get(action.member.student.Id);
      return form && action.key==='Ex' ? action.member.entries.find(e=>e.key===action.member.focus.keys[Math.min(form.step,2)]) : action.entry;
    };
    const cardAvailable = (action, entry) => {
      if (entry.type!=='Ex') return true;
      const form=forms.get(action.member.student.Id);
      return deck.hand.includes(action.member.student.Id) && (form ? !form.finishing && time<form.end && entry.key===action.member.focus.keys[form.step] : entry.key==='Ex');
    };
    const consumeEX = (m, entry) => {
      const id=m.student.Id,mod=costModifiers.get(id);
      if(mod)mod.uses--;
      if(!m.focus){rotateSkill(deck,id);return;}
      if(entry.key==='Ex')forms.set(id,{step:0,end:time+m.focus.window,finishing:false});
      else {
        const form=forms.get(id);form.step++;
        form.finishing=form.step===m.focus.keys.length;
        form.end=time+(form.finishing?(entry.skill.Duration??30)/30:m.focus.window);
      }
    };
    const context = member => {
      if (!contexts.has(member.student.Id)) {
        const p = phases[phase];
        const ctx = teamContext(members, member.student.Id, records, { ...p.enemy, ...corrections, time,
          currentTargetId: member.student.Id }, data, true, prepared);
        if (health) {
          const debuffs = health.bonuses(member.student.Id,time);
          ctx.calculatedStudent = applyStudentBonuses(prepared.get(member.student.Id).calculated, [...ctx.studentBonuses,...debuffs], data, corrections.attackBuff, corrections.critBuff);
          ctx.enemy.calculatedStudent = ctx.calculatedStudent;
          ctx.enemy.enemyBonuses = [...ctx.enemy.enemyBonuses,...health.bonuses(`boss-${p.enemy.character?.Id}`,time)];
          for (const row of health.debuffs) if (row.end>time) nextBoundary=Math.min(nextBoundary,row.end);
        }
        contexts.set(member.student.Id, ctx); nextBoundary = Math.min(nextBoundary, ctx.nextBoundary);
        for (const status of ctx.statuses.values()) if (status.status === 'unsupported') warnings.add(`${member.student.Name}: ${status.reason}`);
      }
      return contexts.get(member.student.Id);
    };
    health = new BattleHealth(ready,context,data); invalidate();
    const applyEnemy = (action, effect, skill, actor) => {
      const activePhase=phases[phase];
      if (action.phase > 0 && action.phase !== phase + 1) return;
      if (actor.Rank === 'Boss' && actor.Id !== activePhase.enemy.character?.Id) return;
      const targets=(action.targetIds ?? [...health.units.keys()]).filter(id=>health.alive(id));
      if (effect.Type==='Damage') for (const id of targets) {
        const target=ready.find(m=>m.student.Id===id); if (!target) continue;
        const c=context(target);
        const result=attackFromEnemy(actor,activePhase.enemy.level,skill,effect,target.student,c.calculatedStudent,data,[],c.enemy.enemyBonuses);
        if (!result.supported) { warnings.add(`${actor.Name} · ${skill.Name}: ${result.reasons.join(' · ')} 제외`); continue; }
        const damage=(incomingMode==='ceiling' ? result.ceiling : result.mean)*(action.damageMultiplier ?? 100)/100;
        const wasAlive=health.alive(id),taken=health.hurt(id,damage,time);
        events.push({time,type:'enemy-damage',label:`${skill.Name} → ${target.student.Name} · ${Math.round(taken).toLocaleString('ko-KR')} 피해`,studentId:id,damage:taken});
        if (wasAlive && !health.alive(id)) {
          endFocus(id,'집중 사격 자세 해제 · 사망');
          removeSkill(deck,id);
          events.push({time,type:'hand',hand:[...deck.hand]});
          events.push({time,type:'death',label:`${target.student.Name} 사망`,studentId:id});
          for (const r of records) if (r.skillId.startsWith(`${id}:`)) {
            const entry=ready.find(m=>m.student.Id===id)?.entries.find(e=>`${id}:${e.key}`===r.skillId);
            if (entry?.skill.Radius) r.endedAt=time;
          }
          invalidate();
        }
      }
      if (effect.Type==='Buff') {
        const self=effect.Target?.includes('Self');
        for (const id of self ? [`boss-${actor.Id}`] : targets) {
          if (!health.debuff(id,effect,skill,time,action.buffDuration ?? (effect.Duration ? effect.Duration/1000 : skill.Type==='Passive' ? 0 : 30),`${actor.Name} · ${skill.Name}`))
            warnings.add(`${actor.Name} · ${skill.Name}: 조건부·특수 디버프 제외`);
        }
        invalidate();
      }
      if (effect.Type==='CrowdControl' && (effect.Chance ?? 10000)===10000) {
        if (effect.Icon !== 'Stunned') { warnings.add(`${actor.Name} · ${skill.Name}: 기절 외 제어 효과 제외`); return; }
        const milliseconds=atLevel(Array.isArray(effect.Scale?.[0])?effect.Scale[0]:effect.Scale,1);
        for (const id of targets) {
          const timer=timers.find(t=>t.member.student.Id===id); if (!timer) continue;
          endFocus(id,'집중 사격 자세 해제 · 기절');
          timer.busy=Math.max(timer.busy,time+milliseconds/1000);timer.normal=Math.max(timer.normal,timer.busy);
          for(let i=shots.length-1;i>=0;i--)if(shots[i].member.student.Id===id)shots.splice(i,1);
          for(let i=recovery.length-1;i>=0;i--)if(recovery[i].member.student.Id===id)recovery.splice(i,1);
          for(let i=costEffects.length-1;i>=0;i--)if(costEffects[i].source===id)costEffects.splice(i,1);
          for(const record of records)if(record.skillId.startsWith(`${id}:`) && record.time<=time)record.interruptedAt??=time;
          invalidate();
          events.push({time,type:'enemy-control',label:`${skill.Name} → ${timer.member.student.Name} · 행동 정지 ${(milliseconds/1000).toFixed(1)}초`});
        }
      }
      if (effect.Type==='DamageDebuff' && effect.Duration && effect.Period) {
        for (let delay=effect.Period/1000; delay<=effect.Duration/1000; delay+=effect.Period/1000)
          enemyEffects.push({action,e:{...effect,Type:'Damage',CriticalCheck:'Never',CanEvade:false,Hits:[10000]},skill,actor,at:time+delay});
      }
    };
    // Explicit passive enemy debuffs have no invented cast schedule.
    const applyPassives = actor => {
      health.debuffs = health.debuffs.filter(row => !row.enemyPassive);
      for (const id of actor?.Skills ?? []) {
        const skill=raidData?.enemySkills[id];
        if (skill?.Type==='Passive') for (const effect of skill.Effects ?? []) if (effect.Type==='Buff') {
          const first=health.debuffs.length;
          applyEnemy({targetIds:[...health.units.keys()],buffDuration:0},effect,skill,actor);
          for (let i=first;i<health.debuffs.length;i++) health.debuffs[i].enemyPassive=true;
        }
      }
      invalidate();
    };
    applyPassives(phases[0].enemy.character);
    const cast = (m, entry, targetId, effectIndex, assumeCondition, impactDelay, manual = false, actionId, buffDuration, spent = 0) => {
      const castId = `${key}-${epoch++}`, level = m.build.skills[entry.parent ?? entry.key] ?? 1;
      let effects=entry.skill.Effects ?? [], effectIndexes;
      if (!effects.length && entry.type!=='Normal' && !(m.focus && entry.key==='Ex')) warnings.add(`${m.student.Name} · ${entry.skill.Name}: 변신·연속 EX 또는 효과 자료가 없는 스킬은 자동 재현하지 않습니다.`);
      if (entry.key==='Public' && entry.skill.Desc?.includes('경우') && effects[0]?.Type==='Shield' && effects[1]?.Type==='Buff' && effects[0].Target==='Self') {
        const unit=health.units.get(m.student.Id),hasShield=unit && health.shield(unit,time)>0;
        effectIndexes=hasShield?[1]:[0]; effects=effects.filter((e,i)=>effectIndexes.includes(i));
      }
      if (entry.skill.Effects?.some(e => e.Type === 'Buff')) {
      const c = context(m);
      records.push({ enabled: true, skillId: `${m.student.Id}:${entry.key}`, eventId: castId,
        targetId, time, order: epoch, assumeCondition, buffDuration, effectIndexes, durationMultiplier: c.calculatedStudent.stats.ExtendBuffDuration / 10000 });
      invalidate();
      }
      if (manual || entry.type !== 'Normal') events.push({ time, type: 'cast', studentId: m.student.Id,
        label: `${m.student.Name} · ${entry.skill.Name ?? entry.type}`, cost, targetId, actionId,
        spent, beforeCost: cost + spent, skillKey:entry.key,
        ...(entry.type === 'Ex' ? {hand:[...deck.hand],nextSkillKey:forms.has(m.student.Id)?m.focus.keys[Math.min(forms.get(m.student.Id).step,2)]:'Ex',stanceUntil:forms.get(m.student.Id)?.end??null} : {}) });
      if (entry.type==='Ex' && m.focus) {
        for(const r of records)if(r.focusId===m.student.Id)r.endedAt=time;
        const form=forms.get(m.student.Id),sub=prepared.get(m.student.Id).skills.find(e=>e.type==='ExtraPassive');
        if(form&&sub){records.push({enabled:true,skillId:sub.id,eventId:`${castId}-focus`,focusId:m.student.Id,time,order:epoch,buffDuration:form.end-time+.1});invalidate();}
      }
      for (const effect of effects.filter(e => e.Type === 'CostChange')) {
        if (effect.Condition && !assumeCondition || !['Coefficient','BaseAmount'].includes(effect.ValueType)) {
          warnings.add(`${m.student.Name}: 조건부 코스트 변경 제외`); continue;
        }
        const opening = /전투 시작 시/.test(entry.skill.Desc ?? '');
        const self = (Array.isArray(effect.Target)?effect.Target:[effect.Target]).includes('Self');
        const targets = self ? [m.student.Id] : opening ? ready.filter(a=>a.student.Id!==m.student.Id).map(a=>a.student.Id) : [targetId];
        costEffects.push({at:time+(effect.ApplyFrame??0)/30,targets,source:m.student.Id,
          modifier:{type:effect.ValueType,value:atLevel(effect.Scale,level),uses:effect.Uses??1}});
      }
      if (entry.type==='Ex') for (const sub of prepared.get(m.student.Id).skills.filter(e=>e.type==='ExtraPassive')) {
        if (/EX 스킬.*(?:사용 시|지속되는 동안)/.test(sub.skill.Desc ?? '') && sub.skill.Effects.every(e=>e.Type==='Buff' && !e.Condition)) {
          const durationText=(entry.skill.Parameters??[]).flat().find(v=>typeof v==='string'&&/^\d+(\.\d+)?초$/.test(v));
          const duration=/지속되는 동안/.test(sub.skill.Desc)?Number(entry.skill.Desc.match(/\((\d+)초간\)/)?.[1] ?? (parseFloat(durationText)||0)):0;
          if (/지속되는 동안/.test(sub.skill.Desc)&&!duration) continue;
          records.push({enabled:true,skillId:sub.id,eventId:`${castId}-sub`,time,order:epoch,buffDuration:duration});invalidate();
        }
      }
      const damages = effects.map((effect, index) => ({ effect, index })).filter(e => e.effect.Type === 'Damage');
      const chosen = damages.find(e => e.index === effectIndex) ?? damages[0];
      if (damages.length > 1) warnings.add(`${m.student.Name} · ${entry.skill.Name}: 선택한 직접 피해 효과 하나만 합산합니다.`);
      if (chosen) {
        const frames=chosen.effect.HitFrames;
        const base=time+(Number.isFinite(impactDelay)?Math.max(0,impactDelay)-(frames?.[0]??0)/30:0);
        const {HitFrames,...effect}=chosen.effect;
        shots.push({time:frames?.length?base+frames[0]/30:time+(Number.isFinite(impactDelay)?Math.max(0,impactDelay):(effect.ApplyFrame??entry.skill.Duration??30)/30),
          member:m,entry,effect:frames?.length?effect:chosen.effect,frames,base,frameIndex:0,level,assumeCondition,actionId});
      }
      for (const effect of effects.filter(e=>['Heal','Shield'].includes(e.Type))) {
        if (effect.Condition && !assumeCondition || !effect.Scale || effect.MultiplySource || effect.StatModifier || effect.TargetHpRateModifier || effect.HitFrames) {
          warnings.add(`${m.student.Name} · ${entry.skill.Name}: 조건부·특수 회복/보호막 제외`); continue;
        }
        const targets=effect.Target==='Self' ? [m.student.Id] : effect.Target==='Any' || entry.skill.Radius ? [...health.units.keys()] : [manual ? targetId : health.lowest()];
        const durationText=(entry.skill.Parameters ?? []).map(row=>atLevel(row,level)).find(v=>typeof v==='string' && /^\d+(\.\d+)?초$/.test(v));
        recovery.push({time:time+(effect.ApplyFrame ?? entry.skill.Duration ?? 30)/30,member:m,effect,level,targets,entry,
          shieldDuration:effect.Type==='Shield'?(durationText?parseFloat(durationText):(effect.Duration ?? 15000)/1000):0});
      }
      if (effects.some(e => !['Damage', 'Buff', 'Heal','Shield','CostChange'].includes(e.Type))) warnings.add(`${m.student.Name} · ${entry.skill.Name ?? entry.type}: 소환·지속 피해 등 특수 효과는 제외했습니다.`);
      return Math.max(.1, (entry.skill.Duration ?? 30) / 30);
    };
    let clearTime = null;
    for (let tick = 0; tick <= Math.round(duration * 10); tick++) {
      time = tick / 10;
      for(const [id,form] of forms)if(!form.finishing&&time+1e-8>=form.end)endFocus(id,'집중 사격 자세 해제 · 시간 만료');
      if (time + 1e-8 >= nextBoundary) invalidate();
      if (phase >= phases.length) break;
      const regen = ready.filter(m=>health.alive(m.student.Id)).reduce((sum, m) => {
        const stats=context(m).calculatedStudent.stats,u=health.units.get(m.student.Id);
        if(u && u.max!==stats.MaxHP){u.hp=Math.min(stats.MaxHP,u.hp/u.max*stats.MaxHP);u.max=stats.MaxHP;}
        return sum+stats.RegenCost;
      }, 0) / 10000;
      if (tick) cost = Math.min(costCap, cost + regen / 10);
      for (let i=0;i<costEffects.length;) {
        const item=costEffects[i];if(item.at>time+1e-8){i++;continue;}costEffects.splice(i,1);
        if (!health.alive(item.source)) continue;
        for (const id of item.targets) if (health.alive(id)) costModifiers.set(id,{...item.modifier});
        events.push({time,type:'cost-buff',label:'코스트 감소 적용',source:item.source,targets:item.targets,modifier:{...item.modifier}});
      }
      const paused = time < pausedUntil;
      if (mode === 'timeline') while (cursor < scheduled.length && scheduled[cursor].at <= time + 1e-8) {
        const action = scheduled[cursor++], timer = timers.find(t => t.member.student.Id === action.member.student.Id);
        const entry=currentEntry(action),id=action.member.student.Id,isEx=entry.type==='Ex';
        const unavailable=!cardAvailable(action,entry);
        const required = isEx ? exCost(entry.skill,action.level,costModifiers.get(id)) : 0;
        const reason = unavailable ? '카드 없음' : !health.alive(id) ? '학생 사망' : paused ? '페이즈 전환 중' : time < castingUntil ? '직전 행동 사용 중' : time < timer.busy ? '학생의 다른 스킬 사용 중' : cost + 1e-8 < required ? `코스트 부족 (${cost.toFixed(2)} / ${required})` : null;
        if (reason) {
          const nextAvailable = unavailable || !health.alive(id) ? Infinity : Math.max(time + .1, pausedUntil, castingUntil, timer.busy,
            time + (required > cost && regen > 0 ? Math.ceil((required - cost) / regen * 10) / 10 : .1));
          events.push({ time, type: 'blocked', actionId: action.actionId, nextAvailable, label: `${action.member.student.Name} · 실행 제외: ${reason}` });
          warnings.add(`${action.at.toFixed(1)}초 ${action.member.student.Name}: ${reason}. 지정 시각의 행동을 제외했습니다.`);
        } else {
          cost -= required;
          if(isEx)consumeEX(action.member,entry);
          const lock = cast(action.member, entry, action.targetId, action.effectIndex, action.assumeCondition, action.sourceTiming?undefined:action.delay, true, action.actionId, action.buffDuration,required);
          castingUntil = time + .5; timer.busy = time + lock; timer.normal = Math.max(timer.normal, timer.busy);
        }
      }
      if (mode !== 'timeline' && !paused && time >= castingUntil && actions.length && (repeat || cursor < actions.length)) {
        const action = actions[cursor % actions.length], timer = timers.find(t => t.member.student.Id === action.member.student.Id);
        const entry=currentEntry(action),id=action.member.student.Id,isEx=entry.type==='Ex';
        const available=cardAvailable(action,entry);
        const required = isEx ? exCost(entry.skill,action.level,costModifiers.get(id)) : 0;
        if (!available) warnings.add('손패에 없는 EX 때문에 순서가 대기 중입니다.');
        if (required > costCap) warnings.add('최대 코스트를 넘는 행동 때문에 순서가 대기 중입니다.');
        if (available && health.alive(id) && time >= (action.earliest ?? 0) && time >= timer.busy && cost + 1e-8 >= required) {
          cost -= required;
          if(isEx)consumeEX(action.member,entry);
          const lock = cast(action.member, entry, action.targetId, action.effectIndex, action.assumeCondition, action.sourceTiming?undefined:action.delay, true, `${action.index}-${Math.floor(cursor / actions.length)}`, action.buffDuration,required);
          castingUntil = time + .5; timer.busy = time + lock; timer.normal = Math.max(timer.normal, timer.busy); cursor++;
        }
      }
      if (!paused) for (const timer of timers) {
        const m = timer.member;
        if (time < timer.busy || !health.alive(m.student.Id)) continue;
        const publicEntry = m.entries.find(e => e.key === 'Public');
        if (publicEntry && (timer.public > 0 || timer.opening) && time + 1e-8 >= timer.public) {
          const lock = cast(m, publicEntry, m.student.Id, 0, false, undefined);
          timer.busy = time + lock; timer.normal = Math.max(timer.normal, timer.busy);
          timer.public = timer.opening ? Infinity : time + (m.timing.publicInterval ?? publicInterval(publicEntry.skill));timer.opening=false; continue;
        }
        const normal = m.entries.find(e => e.key === 'Normal');
        if (normal && !forms.has(m.student.Id) && time + 1e-8 >= timer.normal) {
          const speed = Math.max(.1, context(m).calculatedStudent.stats.AttackSpeed / 10000);
          cast(m, normal, m.student.Id, 0, false, 0); timer.rounds++;
          timer.normal = time + Math.max(.1, m.timing.interval / speed) + (timer.rounds % m.timing.rounds === 0 ? m.timing.reload : 0);
        }
      }
      for (let i = 0; i < shots.length; ) {
        const shot = shots[i];
        if (shot.time > time + 1e-8) { i++; continue; }
        if (shot.frames && shot.frameIndex+1<shot.frames.length) {shot.frameIndex++;shot.time=shot.base+shot.frames[shot.frameIndex]/30;} else shots.splice(i,1);
        if (time < pausedUntil || phase >= phases.length || !health.alive(shot.member.student.Id)) continue;
        const c = context(shot.member), p = phases[phase];
        let cache=damageCache.get(shot.member.student.Id);if(!cache){cache=new Map();damageCache.set(shot.member.student.Id,cache);}
        const cacheKey=shot.effect;
        let variants=cache.get(cacheKey);if(!variants){variants=new Map();cache.set(cacheKey,variants);}
        const variant=`${shot.entry.key}:${shot.level}:${Boolean(shot.assumeCondition)}`;
        let result=variants.get(variant);
        if(!result){result=combatResult(shot.member.student,shot.member.build,data,shot.entry.skill,shot.effect,shot.level,{...c.enemy,skillType:shot.entry.type,assumeCondition:shot.assumeCondition});variants.set(variant,result);}
        if (!result.supported) { warnings.add(`${shot.member.student.Name} · ${shot.entry.skill.Name ?? shot.entry.type}: ${result.reasons.join(' · ')}`); continue; }
        const mechanic=mechanicStates.filter(s=>s.start<=time && time<s.end).at(-1);
        const scale = (p.received ?? 100) / 100 * (mechanic?.received ?? 100)/100;
        mean += result.mean * scale; variance += result.variance * scale * scale; peak += result.ceiling * scale;
        const metric = key === 'mean' ? mean : key === 'lucky' ? Math.min(peak, mean + 1.6448536269514722 * Math.sqrt(variance)) : peak;
        let damage = Math.max(0, metric - lastMetric); lastMetric = metric;
        let credited = 0;
        while (damage > 0 && phase < phases.length) {
          const current = phases[phase], used = Math.min(damage, current.hp - progress);
          progress += used; applied += used; credited += used; damage -= used;
          if (progress + 1e-6 < current.hp) break;
          completions.push({ phase, time }); events.push({ time, type: 'phase', label: `${current.name} 완료` });
          progress = 0; phase++; invalidate();
          if (current.clearDebuffs) for (const record of records) record.enemyClearedAt ??= time;
          if (phase >= phases.length) { clearTime = time; break; }
          if (current.enemy.character?.Id !== phases[phase].enemy.character?.Id) applyPassives(phases[phase].enemy.character);
          pausedUntil = time + (current.wait ?? 0);
          if (!current.carry || current.wait > 0) damage = 0;
        }
        contributions.set(shot.member.student.Id, (contributions.get(shot.member.student.Id) ?? 0) + credited);
        if (shot.entry.type !== 'Normal') events.push({ time, type: 'damage', label: `${shot.member.student.Name} · 피해 ${Math.round(credited).toLocaleString('ko-KR')}`, studentId: shot.member.student.Id, damage: credited, actionId: shot.actionId });
      }
      for(const [id,form] of forms)if(form.finishing&&time+1e-8>=form.end)endFocus(id,'집중 사격 자세 해제 · 사격 완료');
      if (phase < phases.length) {
        for (let i=0;i<recovery.length;) {
          const heal=recovery[i]; if (heal.time>time+1e-8) {i++;continue;} recovery.splice(i,1);
          if (!health.alive(heal.member.student.Id)) continue;
          const c=context(heal.member),value=c.calculatedStudent.stats.HealPower*atLevel(heal.effect.Scale,heal.level)/10000;
          for (const id of heal.targets) {
            const u=health.units.get(id); if (!u) continue;
            const shieldDuration=heal.shieldDuration;
            const recipient=ready.find(m=>m.student.Id===id),recipientStats=context(recipient).calculatedStudent.stats;
            const amount=health.recover(id,value*(shieldDuration ? 1 : recipientStats.HealEffectivenessRate/10000),time,shieldDuration,heal.member.student.Id);
            if (amount>0) events.push({time,type:shieldDuration?'shield':'heal',label:`${heal.member.student.Name} → ${ready.find(m=>m.student.Id===id).student.Name} · ${shieldDuration?'보호막':'회복'} ${Math.round(amount).toLocaleString('ko-KR')}`});
          }
        }
        while (enemyCursor<enemySchedule.length && enemySchedule[enemyCursor].at<=time+1e-8) {
          let action=enemySchedule[enemyCursor++];
          const actor=raidData?.enemies[String(action.enemyId)] ?? phases[phase].enemy.character;
          const skill=raidData?.enemySkills[action.skillId]; if (!actor || !skill) continue;
          if(action.phase>0 && action.phase!==phase+1)continue;
          if(actor.Rank==='Boss' && actor.Id!==phases[phase].enemy.character?.Id)continue;
          if(action.randomPattern) {
            if(actor.Id!==phases[phase].enemy.character?.Id)continue;
            action={...action,targetIds:randomTargets(action,[...health.units.keys()].filter(id=>health.alive(id)))};
          }
          if (action.stateDuration>0) mechanicStates.push({start:time,end:time+action.stateDuration,received:action.bossReceived ?? 100});
          events.push({time,type:'enemy-cast',label:`${actor.Name} · ${skill.Name}`,enemyActionIndex:action.index});
          const effect=skill.Effects?.[action.effectIndex ?? 0];
          const effects=[...new Set([...(['Damage','DamageDebuff','CrowdControl'].includes(effect?.Type)?[effect]:[]),...(skill.Effects ?? []).filter(e=>e.Type==='Buff'||action.randomPattern&&effect?.Type==='Damage'&&e.Type==='CrowdControl')])];
          for (const e of effects) enemyEffects.push({action,e,skill,actor,at:time+(action.delay ?? 0)+(e.ApplyFrame ?? 0)/30});
          if ((skill.Effects ?? []).some(e=>!['Damage','Buff','CrowdControl','DamageDebuff'].includes(e.Type))) warnings.add(`${actor.Name} · ${skill.Name}: 소환·게이지 등 특수 기믹은 설명만 표시합니다.`);
        }
        for (let i=0;i<enemyEffects.length;) {const item=enemyEffects[i];if(item.at>time+1e-8){i++;continue;}enemyEffects.splice(i,1);applyEnemy(item.action,item.e,item.skill,item.actor);}
      }
      if (health.units.size && [...health.units.values()].every(u=>u.deadAt!==null)) wipeTime ??= time;
      if(recordTimeline) timeline.push({ time, damage: applied, phase, remaining: phase < phases.length ? phases[phase].hp - progress : 0, cost, regen, health:health.snapshot(time) });
      if (wipeTime!==null) break;
      if (clearTime !== null) break;
    }
    return { key, clearTime, wipeTime, completions, timeline, events, records, contributions: Object.fromEntries(contributions), damage: applied };
  });
  return { paths, phases, totalHP, duration, costCap, warnings: [...warnings], prepared };
}

export function pointAt(path, time) {
  let lo = 0, hi = path.timeline.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (path.timeline[mid].time <= time) lo = mid; else hi = mid - 1; }
  return path.timeline[lo] ?? { time: 0, damage: 0, phase: 0, remaining: 0, cost: 0 };
}
