import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { attackFromEnemy, BattleHealth } from '../battle.mjs';
import { defaultBuild, studentStats } from '../calc.mjs';
import { prepareTeam, raidEnemy } from '../team.mjs';
import { simulateTactic, pointAt } from '../tactic.mjs';

const data=JSON.parse(await readFile(new URL('../data/global.json',import.meta.url),'utf8'));
const raids=JSON.parse(await readFile(new URL('../data/raids.json',import.meta.url),'utf8'));
const member=name=>{const student=data.students.find(s=>s.Name===name);return {student,build:defaultBuild(student,data.meta.region)};};
const aru=member('아루'),serina=member('세리나'),yuuka=member('유우카');
const raid=raids.raids.find(r=>r.PathName==='binah');
const enemy=raidEnemy(raids,raid,5,raid.EnemyList[5][0],'Outdoor');
const phases=[{name:'target',hp:1e9,enemy,received:100,wait:0}];
const beam=raids.enemySkills.BinahExSkill01;

test('Enemy damage uses the student armor, defense and evasion instead of the boss defense',()=>{
  const stats=studentStats(aru.student,aru.build,data);
  const base=attackFromEnemy(enemy.character,80,beam,beam.Effects[0],aru.student,stats,data);
  const armored=attackFromEnemy(enemy.character,80,beam,beam.Effects[0],{...aru.student,ArmorType:'HeavyArmor'},stats,data);
  assert.ok(Math.abs(armored.mean/base.mean-4)<1e-8);
  const doubled=attackFromEnemy({...enemy.character,AttackPower1:40000,AttackPower100:40000},80,beam,beam.Effects[0],aru.student,stats,data);
  assert.ok(Math.abs(doubled.mean/base.mean-2)<1e-8);
});

test('Shield absorbs damage first, expires at its boundary, and healing never resurrects a dead student',()=>{
  const health=new BattleHealth([aru],()=>({calculatedStudent:{stats:{MaxHP:1000}}}),data);
  const id=aru.student.Id;
  health.recover(id,200,0,5,1);
  assert.equal(health.hurt(id,300,1),100);assert.equal(health.units.get(id).hp,900);
  health.recover(id,300,1,3,1);assert.equal(health.snapshot(4)[id].shield,0);
  assert.equal(health.hurt(id,1000,5),900);assert.equal(health.units.get(id).deadAt,5);
  assert.equal(health.recover(id,1000,6),0);assert.equal(health.units.get(id).hp,0);
});

test('A real scheduled boss attack kills its selected target and stops later damage and cost regeneration',()=>{
  const result=simulateTactic({members:[aru],data,phases,raidData:raids,duration:30,sequence:[],enemyPlan:[{
    enemyId:enemy.character.Id,skillId:'BinahExSkill03',effectIndex:0,time:5,targetIds:[aru.student.Id],damageMultiplier:1000,buffDuration:30}]});
  for(const p of result.paths){assert.equal(p.wipeTime,5);assert.equal(pointAt(p,5).health[aru.student.Id].hp,0);assert.equal(p.timeline.at(-1).time,5);}
  assert.ok(result.paths[0].events.some(e=>e.type==='death'));
});

test('A boss attack cannot hit a support or an unselected striker',()=>{
  const result=simulateTactic({members:[aru,serina],data,phases,raidData:raids,duration:10,sequence:[],enemyPlan:[{
    enemyId:enemy.character.Id,skillId:'BinahExSkill03',effectIndex:0,time:5,targetIds:[serina.student.Id],damageMultiplier:1000}]});
  const u=pointAt(result.paths[0],10).health[aru.student.Id];assert.equal(u.hp,u.max);assert.equal(result.paths[0].wipeTime,null);
});

test('Recovery and a real shield skill change HP while cost validation omits snapshots',()=>{
  const input={members:[yuuka,serina],data,phases,raidData:raids,initialCost:10,duration:12,repeat:false,mode:'timeline',
    enemyPlan:[{enemyId:enemy.character.Id,skillId:'BinahExSkill01',effectIndex:0,time:5,targetIds:[yuuka.student.Id]}],
    sequence:[{studentId:yuuka.student.Id,key:'Ex',earliest:0},{studentId:serina.student.Id,key:'Ex',earliest:7,targetId:yuuka.student.Id}]};
  const r=simulateTactic(input),p=r.paths[0];
  assert.ok(p.events.some(e=>e.type==='shield'));assert.ok(p.events.some(e=>e.type==='heal'));
  assert.ok(pointAt(p,2).health[yuuka.student.Id].shield>0);
  const slim=simulateTactic({...input,recordTimeline:false,caseKeys:['mean']});
  assert.deepEqual(slim.paths[0].events,p.events);assert.equal(slim.paths[0].timeline.length,0);
  assert.equal(slim.paths[0].damage,p.damage);
});

test('Enemy defense debuff lowers incoming protection and max incoming damage is bounded above its mean',()=>{
  const calculated=studentStats(yuuka.student,yuuka.build,data);
  const plain=attackFromEnemy(enemy.character,80,beam,beam.Effects[0],yuuka.student,calculated,data);
  const debuffed=attackFromEnemy(enemy.character,80,beam,beam.Effects[0],yuuka.student,calculated,data,[{stat:'DefensePower_Coefficient',amount:-5000}]);
  assert.ok(debuffed.mean>plain.mean);assert.ok(debuffed.ceiling>=debuffed.mean);
});

test('Manual invulnerability mechanic prevents outgoing damage for the chosen interval',()=>{
  const input={members:[aru],data,phases,raidData:raids,duration:10,sequence:[]};
  const base=simulateTactic(input),immune=simulateTactic({...input,enemyPlan:[{enemyId:enemy.character.Id,skillId:'BinahExSkill01',effectIndex:0,
    time:0,targetIds:[],bossReceived:0,stateDuration:10}]});
  assert.ok(base.paths[0].damage>0);assert.equal(pointAt(immune.paths[0],9.9).damage,0);
});

test('Guaranteed stun cancels a pending EX hit and blocks casting until its end',()=>{
  const result=simulateTactic({members:[aru],data,phases,raidData:raids,initialCost:10,duration:10,repeat:false,mode:'timeline',
    sequence:[{studentId:aru.student.Id,key:'Ex',earliest:0,delay:3},{studentId:aru.student.Id,key:'Ex',earliest:2}],
    enemyPlan:[{enemyId:enemy.character.Id,skillId:'ShiroTormentEx01',effectIndex:7,time:1,targetIds:[aru.student.Id]}]});
  const p=result.paths[0];assert.ok(p.events.some(e=>e.type==='enemy-control'));
  assert.ok(p.events.some(e=>e.type==='blocked' && e.time===2 && e.nextAvailable>=5));
  assert.equal(p.events.some(e=>e.type==='damage' && e.actionId==='0-0'),false);
});

test('Enemy damage over time ticks at the source period and ends at the source duration',()=>{
  const result=simulateTactic({members:[yuuka],data,phases,raidData:raids,duration:15,repeat:false,
    enemyPlan:[{enemyId:enemy.character.Id,skillId:'HieronymusEx02',effectIndex:0,time:1,targetIds:[yuuka.student.Id],damageMultiplier:1}]});
  const times=result.paths[0].events.filter(e=>e.type==='enemy-damage').map(e=>e.time);
  assert.deepEqual(times,[2,3,4,5,6,7,8,9,10,11]);
});

test('An old boss cannot attack after a transition to another boss',()=>{
  const other={...enemy,character:{...enemy.character,Id:999999,Skills:[]}};
  const result=simulateTactic({members:[aru],data,phases:[{...phases[0],hp:1,carry:false},{...phases[0],enemy:other}],raidData:raids,
    duration:10,enemyPlan:[{enemyId:enemy.character.Id,skillId:'BinahExSkill01',effectIndex:0,time:5,targetIds:[aru.student.Id]}]});
  assert.ok(result.paths[0].completions.length>0);
  assert.equal(result.paths[0].events.some(e=>e.type==='enemy-cast'),false);
  assert.equal(pointAt(result.paths[0],10).health[aru.student.Id].hp,pointAt(result.paths[0],10).health[aru.student.Id].max);
});
