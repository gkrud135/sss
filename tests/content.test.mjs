import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rosterStudents, serverRaids, drillRaid, drillRules, matchingSkills } from '../content.mjs';
import { defaultBuild, growthRegion, normalizeBuild, skillDescription, studentStats } from '../calc.mjs';
import { raidEnemy } from '../team.mjs';
import { phaseProfile } from '../tactic.mjs';

const data=JSON.parse(readFileSync(new URL('../data/global.json',import.meta.url)));
const raids=JSON.parse(readFileSync(new URL('../data/raids.json',import.meta.url)));

test('Skill search distinguishes defense down EX, self buffs, and ally cost support',()=>{
  const find=name=>data.students.find(s=>s.Name===name);
  assert.ok(matchingSkills(find('아카네'),data.labels,{effect:'defense',slot:'Ex',target:'enemy'}).length);
  assert.equal(matchingSkills(find('아카네'),data.labels,{effect:'defense',slot:'Ex',target:'ally'}).length,0);
  assert.ok(matchingSkills(find('아코'),data.labels,{effect:'critical',slot:'Ex',target:'ally'}).length);
  assert.ok(matchingSkills(find('우이'),data.labels,{effect:'cost',slot:'Ex',target:'ally'}).length);
  assert.ok(matchingSkills(find('체리노'),data.labels,{effect:'costRegen',slot:'ExtraPassive',target:'self'}).length);
  assert.equal(matchingSkills(find('체리노'),data.labels,{effect:'costRegen',slot:'Ex'}).length,0);
});

test('Skill description search resolves source tags, whitespace and named skill queries',()=>{
  const s=data.students.find(s=>s.Name==='아카네');
  assert.ok(matchingSkills(s,data.labels,{query:'방어력 감소'}).length);
  assert.ok(matchingSkills(s,data.labels,{query:'우아하게, 제거합니다.',slot:'Ex'}).length);
  assert.equal(matchingSkills(s,data.labels,{query:'없는스킬입니다'}).length,0);
});

test('Upgrade and extra skills are discoverable without modifying student growth',()=>{
  const effect={Type:'Buff',Stat:'DefensePower_Coefficient',Value:[[-1000]],Target:['Enemy']};
  const s={Skills:{Public:{Name:'기본'},GearPublic:{Name:'강화',Effects:[effect],ExtraSkills:[{Name:'추가',Effects:[effect]}]}}};
  const matches=matchingSkills(s,data.labels,{effect:'defense',slot:'Public',target:'enemy'});
  assert.deepEqual(matches.map(m=>[m.source,m.key]),[['GearPublic','Public'],['GearPublic','Public:0']]);
  assert.equal(matches[0].skill,s.Skills.GearPublic);
});

test('Drill rule parameters and named effects render as text without exposing source tags',()=>{
  const rule={Desc:"효과 <d:DamageRatio='주는 대미지 감소'> <?1>",Parameters:[['5%']]};
  assert.equal(skillDescription(rule,1,data.labels),'효과 주는 대미지 감소 5%');
});

test('Global and Japan-only filters partition the shared roster without duplicate students',()=>{
  const global=rosterStudents(data.students,'global'),japan=rosterStudents(data.students,'japan-only');
  assert.equal(global.length,data.meta.globalCount);assert.equal(japan.length,data.meta.japanOnlyCount);
  assert.equal(global.length+japan.length,data.students.length);
  assert.equal(new Set([...global,...japan].map(s=>s.Id)).size,data.students.length);
  assert.ok(japan.some(s=>s.Id===10151));assert.ok(japan.every(s=>growthRegion(s,data).Name==='Jp'));
});

test('A Japan-only gear release is usable under Japanese growth rules and locked under global rules',()=>{
  const original=data.students.find(s=>s.Id===10000);
  const student={...original,IsReleased:[true,false],Gear:{...original.Gear,Released:[true,false]}};
  const region=growthRegion(student,data),build={...defaultBuild(student,region),stars:5,bond:20,gear:2};
  assert.equal(normalizeBuild(student,build,region).gear,2);
  assert.equal(normalizeBuild(student,build,data.meta.region).gear,0);
  assert.ok(studentStats(student,build,data).stats.MaxHP>0);
});

test('Japanese Hieronymus LUNATIC does not become a global difficulty',()=>{
  const jp=serverRaids(raids.raids,0).find(r=>r.PathName==='hieronymus');
  const global=serverRaids(raids.raids,1).find(r=>r.PathName==='hieronymus');
  assert.equal(jp.MaxDifficulty,7);assert.equal(global.MaxDifficulty,6);
  const eliminated=serverRaids(raids.raids,1,'eliminate');
  assert.ok(eliminated.every(r=>r.EliminateVariants.length));
  assert.ok(eliminated.every(r=>r.EliminateVariants.every(v=>v.MaxDifficulty<=r.MaxDifficulty)));
});

test('Every released drill stage resolves actual enemies, rules, HP and source time limits',()=>{
  for(const drill of raids.drills){
    const raid=drillRaid(drill,0);
    for(let stage=0;stage<=raid.MaxDifficulty;stage++){
      assert.ok(raid.BattleDuration[stage]>0);
      assert.ok(drillRules(raids,drill,stage).every(r=>r.Name&&r.Desc));
      const ids=raid.EnemyList[stage].filter(id=>!raids.enemies[String(id)].IsNPC);
      assert.ok(ids.length);
      for(const id of ids){
        const enemy=raidEnemy(raids,raid,stage,id,drill.Terrain,drill.ArmorType);
        assert.ok(enemy.hp>0&&Number.isFinite(enemy.defense));
        const phases=phaseProfile(raids,raid,stage,enemy,drill.Terrain,drill.ArmorType);
        assert.equal(phases.length,1);assert.equal(phases[0].hp,enemy.hp);
        assert.equal(phases[0].enemy.character.Id,id);
      }
    }
  }
});

test('Drill 8 enemy HP reduction is applied before selected-target tactic calculations',()=>{
  const drill=raids.drills.find(d=>d.Id===8),raid=drillRaid(drill);
  const enemy=raidEnemy(raids,raid,3,7801104,drill.Terrain,drill.ArmorType);
  assert.equal(enemy.hp,15); // Source base 46055, EnemyExtraStats -46040.
  assert.equal(phaseProfile(raids,raid,3,enemy,drill.Terrain,drill.ArmorType)[0].hp,15);
});

test('NPCs remain available as source data without becoming attack targets, and Japan-only rounds are marked',()=>{
  const drill=raids.drills.find(d=>d.Id===54);
  assert.deepEqual(drill.IsReleased.slice(0,2),[true,false]);
  assert.equal(raids.enemies['7832404'].IsNPC,true);
  assert.equal(drillRaid(drill,0).EnemyList[3].filter(id=>!raids.enemies[String(id)].IsNPC).length,3);
});
