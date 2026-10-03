import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { combatResult, defaultBuild } from '../calc.mjs';
import { simulateTactic, pointAt } from '../tactic.mjs';
import { actionDamage } from '../tactic-ui.mjs';

const data=JSON.parse(await readFile(new URL('../data/global.json',import.meta.url),'utf8'));
const raids=JSON.parse(await readFile(new URL('../data/raids.json',import.meta.url),'utf8'));
const member=id=>{const student=data.students.find(s=>s.Id===id);return {student,build:defaultBuild(student,data.meta.region)};};
const enemy={level:80,defense:5000,armor:'HeavyArmor',terrain:'Street',critResist:100,critDmgResist:50,evasion:0};
const phases=[{name:'target',hp:1e9,enemy,wait:0}];
const input=members=>({members,data,phases,duration:35,initialCost:10,mode:'timeline',repeat:false,caseKeys:['mean'],settings:Object.fromEntries(members.map(m=>[m.student.Id,{first:999,publicInterval:0}]))});
const ex=(studentId,earliest,key='Ex')=>({studentId,key,earliest,sourceTiming:true});
const casts=r=>r.paths[0].events.filter(e=>e.type==='cast'&&e.actionId!==undefined);
const hits=(r,id)=>r.paths[0].events.filter(e=>e.type==='damage'&&e.actionId===id);

test('Attacks that explicitly ignore stability always use maximum stability',()=>{
  const hina=member(10086),skill=hina.student.Skills.Ex.ExtraSkills[0],effect=skill.Effects[0];
  const r=combatResult(hina.student,hina.build,data,skill,effect,1,enemy);
  assert.equal(r.stability,1);assert.equal(r.nonCrit.min,r.nonCrit.max);
  const ordinary=combatResult(hina.student,hina.build,data,skill,{...effect,ApplyStability:true},1,enemy);
  assert.ok(ordinary.stability<1);assert.ok(r.mean>ordinary.mean);
});

test('Dress Hina reserves her card for three zero-cost shots, then returns it to the deck',()=>{
  const members=[10086,13010,10007,13000,26003,20008].map(member);
  const r=simulateTactic({...input(members),sequence:[5,7,10,13].map(t=>ex(10086,t))});
  assert.deepEqual(casts(r).map(e=>e.spent),[6,0,0,0]);
  assert.deepEqual(casts(r).map(e=>e.skillKey),['Ex','Ex:0','Ex:1','Ex:2']);
  assert.ok(casts(r).every(e=>e.hand.includes(10086)));
  assert.equal(hits(r,'0-0').length,0);assert.equal(hits(r,'1-0').length,1);
  assert.equal(hits(r,'2-0').length,1);assert.equal(hits(r,'3-0').length,1);
  const ended=r.paths[0].events.find(e=>e.type==='form-end');
  assert.equal(ended.time,14.2);assert.deepEqual(ended.hand,[13000,13010,10007]);
  assert.ok(!r.warnings.some(w=>w.includes('히나(드레스)')&&w.includes('자동 재현하지')));
});

test('Follow-up EX cannot be fired without entering the stance or out of order',()=>{
  const members=[member(10086)];
  const missing=simulateTactic({...input(members),sequence:[ex(10086,5,'Ex:0')]});
  assert.equal(casts(missing).length,0);assert.equal(hits(missing,'0-0').length,0);
  const wrong=simulateTactic({...input(members),sequence:[ex(10086,5),ex(10086,7,'Ex:1')]});
  assert.equal(casts(wrong).length,1);assert.equal(hits(wrong,'1-0').length,0);
});

test('Each focus shot refreshes its ten-second window; timeout rotates the card',()=>{
  const members=[10086,13010,10007,13000,26003,20008].map(member);
  const r=simulateTactic({...input(members),sequence:[ex(10086,5),ex(10086,14),ex(10086,24)]});
  assert.equal(casts(r).length,2);
  const ended=r.paths[0].events.find(e=>e.type==='form-end');assert.equal(ended.time,24);
  assert.ok(!ended.hand.includes(10086));
});

test('Normal attacks stop during the focus stance and resume after it ends',()=>{
  const hina=member(10086),base=input([hina]);base.settings[10086]={first:1,interval:1,rounds:999,reload:0,publicInterval:0};
  const plain=simulateTactic({...base,sequence:[],duration:16});
  const focus=simulateTactic({...base,sequence:[ex(10086,5)],duration:16});
  assert.equal(pointAt(focus.paths[0],14.9).damage,pointAt(focus.paths[0],5).damage);
  assert.ok(pointAt(focus.paths[0],16).damage>pointAt(focus.paths[0],14.9).damage);
  assert.ok(plain.paths[0].damage>focus.paths[0].damage);
});

test('A guaranteed stun cancels the stance, its sub-buff and a pending shot',()=>{
  const hina=member(10086);
  const actor=raids.enemies['7300600'];
  const r=simulateTactic({...input([hina]),phases:[{...phases[0],enemy:{...enemy,character:actor}}],raidData:raids,
    sequence:[ex(10086,5),ex(10086,7),ex(10086,8)],enemyPlan:[{enemyId:actor.Id,skillId:'ShiroTormentEx01',effectIndex:7,time:7.5,targetIds:[10086]}]});
  assert.ok(r.paths[0].events.some(e=>e.type==='form-end'&&e.time===7.5));
  assert.equal(hits(r,'1-0').length,0);
  assert.ok(r.paths[0].records.filter(e=>e.focusId===10086).every(e=>e.endedAt<=7.5));
});

test('HitFrames are applied over time; action totals include all twenty ticks',()=>{
  const saya=member(20006);
  const r=simulateTactic({...input([saya]),sequence:[ex(20006,5)]});
  const damage=hits(r,'0-0');assert.deepEqual(damage.map(e=>e.time),Array.from({length:20},(_,i)=>6+i));
  assert.ok(damage.every(e=>Math.abs(e.damage-damage[0].damage)<1e-6));
  assert.equal(pointAt(r.paths[0],5.9).damage,0);
  const total=actionDamage(r.paths[0],'0-0');assert.equal(total.count,20);
  assert.ok(Math.abs(total.damage-damage[0].damage*20)<1e-6);
  assert.equal(total.first,6);assert.equal(total.last,25);
});

test('Damage reused under the same state is recalculated when an attack buff applies and expires',()=>{
  const chise=member(13001),himari=member(20020),members=[chise,himari];
  const r=simulateTactic({...input(members),sequence:[ex(13001,5),{...ex(20020,10),targetId:13001},ex(13001,19)]});
  const damage=[...hits(r,'0-0'),...hits(r,'2-0')],byTime=t=>damage.find(e=>e.time===t).damage;
  assert.ok(byTime(11)>byTime(9));assert.ok(Math.abs(byTime(11)-byTime(12))<1e-6);
  assert.ok(Math.abs(byTime(25)-byTime(9))<1e-6);
});

test('One-shot inspection sums repeated hits, while the timeline evaluates each source frame',()=>{
  const saya=member(20006),skill=saya.student.Skills.Ex,effect=skill.Effects[0],{HitFrames,...tick}=effect;
  const all=combatResult(saya.student,saya.build,data,skill,effect,1,enemy);
  const single=combatResult(saya.student,saya.build,data,skill,tick,1,enemy);
  assert.equal(all.hitCount,20);assert.equal(all.mean,single.mean*20);assert.equal(all.variance,single.variance*20);
});
