import { atLevel, clamp, combatResult, defaultBuild, growthRegion, normalizeBuild, sanitizeBuild, skillDescription, skillOptions, studentStats, SKILL_NAMES } from './calc.mjs';
import { DIFFICULTIES, prepareTeam, raidEnemy, teamContext } from './team.mjs';
import { TacticUI } from './tactic-ui.mjs';
import { DRILL_NAMES, drillRaid, drillRules, rosterStudents, serverRaids, matchingSkills, SKILL_FILTERS } from './content.mjs';

const $ = id => document.getElementById(id);
const number = n => Math.round(n).toLocaleString('ko-KR');
const percent = n => `${(n * 100).toFixed(1)}%`;
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const equipmentNames = { Hat: '모자', Gloves: '장갑', Shoes: '신발', Bag: '가방', Badge: '배지', Hairpin: '헤어핀', Charm: '부적', Watch: '시계', Necklace: '목걸이' };
const roles = { DamageDealer: '딜러', Tanker: '탱커', Healer: '힐러', Supporter: '서포터', Vehicle: '택티컬 서포트' };
const effectNames = { Damage: '직접 피해', Heal: '회복', Buff: '버프 / 디버프', Shield: '보호막', Summon: '소환', DamageDebuff: '지속 피해', Accumulation: '축적 피해', CrowdControl: '군중 제어', Regen: '지속 회복', Special: '특수 효과', CostChange: '코스트 변경', Dispel: '효과 해제', Knockback: '넉백', ConcentratedTarget: '집중 공격' };
const enemyFields = { armor: 'enemy-armor', terrain: 'terrain', level: 'enemy-level', defense: 'enemy-defense',
  attackBuff: 'attack-buff', critBuff: 'crit-buff', defDown: 'def-down', penetration: 'penetration', effectiveBuff: 'effective-buff',
  exBuff: 'ex-buff', critResist: 'crit-resist', critDmgResist: 'crit-dmg-resist', evasion: 'evasion', damageBuff: 'damage-buff' };
let data, student, build, selectedSkill = 'Ex', selectedEffect = 0;
let raidData, raidPreset = null;
let activeRaid = null, activeMode = 'raid';
const battleDrafts = new Map();
let preparedTeam, contextForSelection, tactic;
const savedBuilds = new Map(), savedSelections = new Map();
const teamIds = [10000, 13010, 10007, 13000, 26003, 20008];
const terrainNames = { Street: '시가지', Outdoor: '야외', Indoor: '실내' };
const currentRegion = () => growthRegion(student, data);

const workspaceViews = {
  students: ['STUDENT LIBRARY', '학생·스킬 검색', '필요한 효과를 가진 학생을 찾고 스킬 수치를 확인하세요.'],
  team: ['TEAM BUILDER', '팀 편성', '스트라이커 4명과 스페셜 2명. 각 학생의 육성을 조절하세요.'],
  tactic: ['TACTIC SIMULATOR', '택틱 시뮬레이터', 'EX 카드와 보스 기믹을 시간선에 놓고 전투 경과를 확인하세요.']
};
function setWorkspaceView(view) {
  if (!workspaceViews[view]) return;
  $('workspace').dataset.view = view;
  document.querySelector('.roster-panel').hidden = view === 'tactic';
  $('reset').hidden = view === 'tactic';
  for (const button of $('workspace-tabs').querySelectorAll('[data-workspace]')) {
    const active = button.dataset.workspace === view;
    button.setAttribute('aria-selected', active); button.tabIndex = active ? 0 : -1;
    $(button.getAttribute('aria-controls')).hidden = !active;
  }
  if (view !== 'tactic') $(view === 'team' ? 'team-detail-host' : 'student-detail-host').append($('student-details'));
  const [label, title, description] = workspaceViews[view];
  $('workspace-eyebrow').textContent = `SCHALE / ${label}`;
  $('workspace-title').textContent = title; $('workspace-description').textContent = description;
  window.scrollTo({ top: 0 });
}
function skillSearchSettings() {
  return { query: $('skill-search').value, effect: $('skill-effect-filter').value,
    slot: $('skill-slot-filter').value, target: $('skill-target-filter').value };
}

function members() { return teamIds.filter(Boolean).map(id => {
  const s = data.students.find(s => s.Id === id);
  if (id !== student.Id && !savedBuilds.has(id)) savedBuilds.set(id, defaultBuild(s, growthRegion(s, data)));
  return { student: s, build: id === student.Id ? build : savedBuilds.get(id) };
}); }
function currentContext() { return contextForSelection; }

function renderTeam() {
  savedBuilds.set(student.Id, build);
  $('team-slots').innerHTML = teamIds.map((id, slot) => {
    const s = data.students.find(s => s.Id === id);
    const b = s ? id === student.Id ? build : savedBuilds.get(id) ?? defaultBuild(s,growthRegion(s,data)) : null;
    return `<div class="team-slot ${id === student.Id ? 'active' : ''}"><small>${slot < 4 ? `STRIKER ${slot + 1}` : `SPECIAL ${slot - 3}`}</small><button class="team-member" data-team-edit="${slot}" ${!s ? 'disabled' : ''} aria-label="${s ? `${escape(s.Name)} 육성 수정` : '빈 자리'}">${s ? `<img src="https://schaledb.com/images/student/collection/${s.Id}.webp" alt="">${escape(s.Name)}${s.IsReleased?.[1]===false?' <em class="jp-label">JP</em>':''}` : '빈 자리'}</button>${s ? `<span class="team-growth-summary" data-growth-student="${s.Id}">Lv.${b.level} · ${b.stars}성 · EX ${b.skills.Ex}</span><button class="team-remove" data-team-remove="${slot}">편성 해제</button>` : ''}</div>`;
  }).join('');
  const positions = student.SquadType === 'Main' ? [0, 1, 2, 3] : [4, 5];
  const old = Number($('team-position').value);
  options($('team-position'), positions.map(i => [i, `${i < 4 ? `스트라이커 ${i + 1}` : `스페셜 ${i - 3}`}${teamIds[i] ? ` · ${data.students.find(s => s.Id === teamIds[i]).Name}` : ' · 빈 자리'}`]), positions.includes(old) ? old : positions.find(i => !teamIds[i]) ?? positions[0]);
  $('team-current-name').textContent = student.Name;
  $('tactic-team-summary').textContent = `현재 파티 · ${teamIds.map(id => data.students.find(s => s.Id === id)?.Name ?? '빈 자리').join(' / ')}`;
}

function renderRaid() {
  const mode = $('raid-mode').value;
  const server = Number($('battle-server').value);
  activeRaid = null;
  $('battle-tabs').querySelectorAll('[data-battle-mode]').forEach(button => { const active=button.dataset.battleMode===mode; button.setAttribute('aria-selected',active);button.tabIndex=active?0:-1; });
  $('drill-type-field').hidden = mode !== 'drill';
  $('drill-rules').hidden = mode !== 'drill';
  $('raid-selector-title').textContent = mode === 'drill' ? '시험 회차' : '보스';
  $('battle-server').disabled = mode === 'custom';
  $('combat-model-note').textContent = mode === 'drill' ? '종합전술시험은 선택한 적 1체의 기본 수치를 기준으로 계산합니다. 특수 시험 규칙은 설명만 표시하며 자동 적용하지 않습니다. 결과는 전체 시험 클리어 시간·점수가 아닙니다.' : '실전 계산은 배치한 보스 패턴을 사용합니다. 보스 AI·이동·위치·성배·게이지 등은 미검증이며 자동 재현되지 않습니다. 실험용 랜덤 모드는 실제 AI의 규칙·확률과 다른 예시입니다.';
  for (const id of ['raid-boss', 'raid-difficulty', 'raid-target']) $(id).disabled = mode === 'custom';
  $('enemy-armor').disabled = mode === 'raid' || mode === 'drill';
  if (mode === 'custom') {
    raidPreset = null; options($('terrain'), Object.entries(terrainNames), $('terrain').value);
    options($('enemy-armor'), Object.entries(data.labels.ArmorType), $('enemy-armor').value);
    $('raid-info').textContent = '적 수치를 직접 설정합니다.'; return;
  }
  if (mode === 'drill') {
    const available = raidData.drills.filter(d => d.IsReleased[server] && (!$('drill-type').value || d.DungeonType === $('drill-type').value));
    const drill = available.find(d => String(d.Id) === $('raid-boss').value) ?? available.at(-1);
    options($('raid-boss'),available.map(d => [d.Id,`${d.Id}회차 · ${DRILL_NAMES[d.DungeonType]}${d.IsReleased[1]?'':' · JP'}`]),drill.Id);
    activeRaid = drillRaid(drill,server);
    const difficulty = clamp(Number($('raid-difficulty').value || 0),0,activeRaid.MaxDifficulty);
    options($('raid-difficulty'),Array.from({length:activeRaid.MaxDifficulty+1},(_,i)=>[i,`${i+1}단계`]),difficulty);
    options($('terrain'),[[drill.Terrain,terrainNames[drill.Terrain]]],drill.Terrain);
    const targets = activeRaid.EnemyList[difficulty].filter(id=>!raidData.enemies[String(id)].IsNPC);
    const target = targets.includes(Number($('raid-target').value)) ? Number($('raid-target').value) : targets[0];
    options($('raid-target'),targets.map(id=>[id,raidData.enemies[String(id)].Name]),target);
    raidPreset = raidEnemy(raidData,activeRaid,difficulty,target,drill.Terrain,drill.ArmorType);
    options($('enemy-armor'),[[raidPreset.armor,data.labels.ArmorType[raidPreset.armor]]],raidPreset.armor);
    for(const key of ['level','defense','critResist','critDmgResist','evasion'])$(enemyFields[key]).value=raidPreset[key];
    $('raid-info').textContent=`${activeRaid.Name} · ${difficulty+1}단계 · ${terrainNames[drill.Terrain]} · 선택한 적 HP ${number(raidPreset.hp)} · 제한 ${drill.BattleDuration[difficulty]}초. 선택한 적 1체 기준의 택틱 계산입니다.`;
    $('drill-rules').innerHTML=`<strong>이 단계의 시험 규칙</strong>${drillRules(raidData,drill,difficulty).map(r=>`<div><b>${escape(r.Name)}</b><p>${escape(skillDescription(r,1,data.labels))}</p></div>`).join('')}<p class="helper">지형·방어 타입·원본 적 수치와 EnemyExtraStats를 반영합니다. 특수 시험 규칙은 아래 보정 입력과 페이즈 설정으로 직접 조정하세요. 적 웨이브·허수아비 회복·호위 대상·3부대 합산 점수는 계산하지 않습니다. 결과의 완료 시간은 선택한 적 기준입니다.</p>`;
    return;
  }
  const available = serverRaids(raidData.raids,server,mode);
  const bossId = available.some(r => r.Id === Number($('raid-boss').value)) ? Number($('raid-boss').value) : available[0].Id;
  options($('raid-boss'), available.map(r => [r.Id, r.Name]), bossId);
  const raid = available.find(r => r.Id === bossId);
  activeRaid = raid;
  const terrains = mode === 'raid' ? raid.Terrain : [...new Set(raid.EliminateVariants.map(v => v.Terrain))];
  const terrain = terrains.includes($('terrain').value) ? $('terrain').value : terrains[0];
  options($('terrain'), terrains.map(t => [t, terrainNames[t]]), terrain);
  const variants = raid.EliminateVariants.filter(v => v.Terrain === terrain);
  const armors = mode === 'raid' ? [raid.ArmorType] : [...new Set(variants.map(v => v.ArmorType))];
  const armor = armors.includes($('enemy-armor').value) ? $('enemy-armor').value : armors[0];
  options($('enemy-armor'), armors.map(a => [a, data.labels.ArmorType[a]]), armor);
  const maxDifficulty = mode === 'raid' ? raid.MaxDifficulty : variants.find(v => v.ArmorType === armor).MaxDifficulty;
  const difficulty = clamp(Number($('raid-difficulty').value || 5), 0, maxDifficulty);
  options($('raid-difficulty'), DIFFICULTIES.slice(0, maxDifficulty + 1).map((name, i) => [i, name]), difficulty);
  const enemyIds = raid.EnemyList[difficulty].filter(id => !raidData.enemies[String(id)].IsNPC);
  let enemyId = enemyIds.includes(Number($('raid-target').value)) ? Number($('raid-target').value) : enemyIds[0];
  if (raid.PathName === 'perorodzilla') enemyId = enemyIds.find(id => raidData.enemies[String(id)].Name.includes(terrain === 'Outdoor' ? '야전' : '실내전')) ?? enemyId;
  options($('raid-target'), enemyIds.map(id => [id, raidData.enemies[String(id)].Name]), enemyId);
  raidPreset = raidEnemy(raidData, raid, difficulty, enemyId, terrain, mode === 'eliminate' ? armor : null);
  if (mode === 'raid') options($('enemy-armor'), [[raidPreset.armor, data.labels.ArmorType[raidPreset.armor]]], raidPreset.armor);
  for (const key of ['level', 'defense', 'critResist', 'critDmgResist', 'evasion']) $(enemyFields[key]).value = raidPreset[key];
  $('raid-info').textContent = `${raid.Name} · ${DIFFICULTIES[difficulty]} · ${terrainNames[terrain]} · 대상 HP ${number(raidPreset.hp)}. ${mode === 'eliminate' ? `${server===0?'일본':'한국·글로벌'} 대결전 개최 이력이 있는 타입·난이도입니다. ` : ''}보스 기본 능력치를 불러왔습니다. 기믹 상태는 별도 설정이 필요합니다.`;
}

function options(select, items, value) {
  select.replaceChildren(...items.map(([v, label]) => { const option = new Option(label, v); option.selected = String(v) === String(value); return option; }));
}

const draftFields = [...Object.values(enemyFields),'battle-server','drill-type','raid-boss','raid-difficulty','raid-target',
  'sim-duration','initial-cost','tactic-mode','sequence-repeat','cycle-seconds','boss-pattern-mode','boss-pattern-interval','incoming-mode'];
function restoreControls(values) {
  for(const [id,value] of Object.entries(values)) {
    const el=$(id);
    if(el.type==='checkbox'){el.checked=value;continue;}
    if(el.tagName==='SELECT' && ![...el.options].some(o=>o.value===String(value)))el.add(new Option(value,value));
    el.value=value;
  }
}
function setBattleMode(mode) {
  if(!tactic || mode===activeMode)return;
  const controls=Object.fromEntries(draftFields.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));
  battleDrafts.set(activeMode,{controls,teamIds:[...teamIds],tactic:tactic.captureDraft()});
  activeMode=mode;$('raid-mode').value=mode;
  const draft=battleDrafts.get(mode);
  if(draft){restoreControls(draft.controls);teamIds.splice(0,teamIds.length,...draft.teamIds);renderTeam();}
  else restoreControls({'drill-type':'','raid-boss':'','raid-target':'','raid-difficulty':mode==='drill'?3:5,
    terrain:'Street','tactic-mode':'timeline','sequence-repeat':false,'cycle-seconds':30,'initial-cost':0,
    'boss-pattern-mode':'manual','incoming-mode':'mean',...Object.fromEntries(['attack-buff','crit-buff','def-down','penetration','effective-buff','ex-buff','damage-buff'].map(id=>[id,0]))});
  renderRaid();
  if(draft)restoreControls(draft.controls);
  tactic.restoreDraft(draft?.tactic);update();
}

function enemySettings() {
  const result = { ...(raidPreset ?? {}), currentTargetId: student?.Id };
  for (const [key, id] of Object.entries(enemyFields)) result[key] = ['armor', 'terrain'].includes(key) ? $(id).value : Number($(id).value);
  result.assumeCondition = $('condition-assume').checked;
  result.skillType = currentSkill()?.type ?? 'Ex';
  return result;
}

function renderRoster() {
  const query = $('search').value.trim().toLocaleLowerCase().replace(/\s/g, '');
  const school = $('school-filter').value, type = $('type-filter').value;
  const filters = skillSearchSettings(), skillSearching = Object.values(filters).some(v => v.trim());
  const filtered = rosterStudents(data.students,$('release-filter').value).filter(s => s.Name.toLocaleLowerCase().replace(/\s/g, '').includes(query) && (!school || s.School === school) && (!type || s.BulletType === type)).flatMap(s => {
    if (!skillSearching) return [{ student: s, match: null }];
    const match = matchingSkills(s, data.labels, filters)[0];
    return match ? [{ student: s, match }] : [];
  });
  $('roster-count').textContent = `${filtered.length} / ${data.students.length}`;
  $('student-list').innerHTML = filtered.length ? filtered.map(({student:s,match}) => `<div role="listitem"><button type="button" class="student-item type-${escape(s.BulletType)}" data-student="${s.Id}" ${match?`data-match-skill="${escape(match.key)}" data-match-source="${escape(match.source)}"`:''} aria-pressed="${s.Id === student.Id}"><img class="avatar" src="https://schaledb.com/images/student/collection/${s.Id}.webp" loading="lazy" decoding="async" alt=""><span><strong>${escape(s.Name)}${s.IsReleased?.[1]===false?' <em class="jp-label">JP</em>':''}</strong><small>${escape(data.labels.School[s.School] ?? s.School)} · ${escape(roles[s.TacticRole] ?? s.TacticRole)}</small>${match?`<small class="skill-match">${escape(SKILL_NAMES[match.type])} · ${escape(match.skill.Name)}${match.source==='GearPublic'?' · 애용품 T2':match.source==='WeaponPassive'?' · 고유무기 2성':''}</small>`:''}</span><i class="type-dot" aria-hidden="true"></i></button></div>`).join('') : '<p class="empty">검색 결과가 없습니다.<br>검색어나 필터를 바꿔 보세요.</p>';
}

function selectStudent(id, updateHash = true) {
  $('search-skill-preview')?.remove();
  if (student && build) { savedBuilds.set(student.Id, build); savedSelections.set(student.Id, { skill: selectedSkill, effect: selectedEffect }); }
  student = data.students.find(s => s.Id === Number(id)) ?? data.students.find(s => s.Id === 10000) ?? data.students[0];
  build = savedBuilds.get(student.Id) ?? defaultBuild(student, currentRegion());
  selectedSkill = savedSelections.get(student.Id)?.skill ?? 'Ex'; selectedEffect = savedSelections.get(student.Id)?.effect ?? 0;
  $('condition-assume').checked = false;
  if (updateHash) history.replaceState(null, '', `#student-${student.Id}`);
  $('student-profile').innerHTML = `<div class="profile-info"><div class="student-school">${escape(data.labels.School[student.School] ?? student.School)} <span> / ${student.SquadType === 'Main' ? 'STRIKER' : 'SPECIAL'}</span></div><h2>${escape(student.Name)}</h2><div class="student-stars" aria-label="기본 ${student.StarGrade}성">${'★'.repeat(student.StarGrade)}</div><div class="tags"><span class="tag attack type-${escape(student.BulletType)}">${escape(data.labels.BulletType[student.BulletType])}</span><span class="tag">${escape(data.labels.ArmorType[student.ArmorType])}</span><span class="tag">${escape(roles[student.TacticRole] ?? student.TacticRole)}</span><span class="tag">${escape(student.WeaponType)}</span></div></div><div class="profile-watermark" aria-hidden="true">BLUE</div><img class="portrait" src="https://schaledb.com/images/student/portrait/${student.Id}.webp" decoding="async" alt="${escape(student.Name)}"><span class="profile-number">STUDENT FILE / ${student.Id}</span>`;
  options($('stars'), Array.from({ length: 6 - student.StarGrade }, (_, i) => [i + student.StarGrade, `${i + student.StarGrade}성`]), build.stars);
  options($('weapon-stars'), [[0, '미장착'], ...Array.from({ length: currentRegion().WeaponMaxLevel / 10 - 2 }, (_, i) => [i + 1, `고유무기 ${i + 1}성`])], 0);
  $('equipment-fields').innerHTML = student.Equipment.map((category, slot) => `<label>${equipmentNames[category] ?? escape(category)}<select id="equipment-${slot}" data-equipment="${slot}" aria-label="${equipmentNames[category]} 티어">${[[0, '미장착'], ...Array.from({ length: currentRegion().EquipmentMaxLevel[slot] }, (_, i) => [i + 1, `T${i + 1}`])].map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}</select></label>`).join('');
  renderGrowth(); renderRoster(); renderTeam(); update();
}

function renderGrowth() {
  build = sanitizeBuild(student, build, currentRegion());
  const b = normalizeBuild(student, build, currentRegion());
  $('growth-server-note').textContent = `${student.Name} · ${currentRegion().Name==='Jp'?'일본':'한국·글로벌'} 육성 기준`;
  $('level').max = $('level-range').max = currentRegion().StudentMaxLevel;
  $('max-level-label').textContent = `Lv. ${currentRegion().StudentMaxLevel}`;
  $('level').value = $('level-range').value = b.level;
  $('stars').value = b.stars; $('bond').value = build.bond; $('bond').max = currentRegion().BondMaxLevel;
  $('weapon-stars').value = build.weaponStars; $('weapon-stars').disabled = b.stars < 5;
  $('weapon-level').value = build.weaponLevel; $('weapon-level').disabled = !b.weaponStars; $('weapon-level').max = currentRegion().WeaponMaxLevel;
  $('gear').value = build.gear; $('gear').disabled = !student.Gear?.Released?.[currentRegion().Name==='Jp'?0:1] || b.bond < currentRegion().GearBondReq[0];
  [...$('gear').options].forEach(option => { const tier = Number(option.value); option.disabled = Boolean(tier && b.bond < currentRegion().GearBondReq[tier - 1]); option.textContent = tier ? `T${tier} · 인연 ${currentRegion().GearBondReq[tier - 1]}+` : '미장착'; });
  $('potential').value = build.potential; $('potential').disabled = b.stars < 5 || b.level < 90;
  $('passive-enabled').checked = b.passive;
  build.equipment.forEach((tier, i) => { $(`equipment-${i}`).value = tier; $(`equipment-${i}`).disabled = b.level < [1, 15, 35][i]; });
}

function currentSkill() {
  const entries = skillOptions(student, normalizeBuild(student, build, currentRegion()));
  return entries.find(s => s.key === selectedSkill) ?? entries[0];
}

function conditionDescription(c) {
  if (!c) return '';
  const operand = { Equal: '일 때', NotEqual: '아닐 때', Greater: '보다 클 때', Less: '보다 작을 때' }[c.Operand] ?? '조건';
  if (c.Type === 'TargetProp') {
    const name = { School: '학원', ArmorType: '방어 타입', Size: '크기', Id: '특정 대상' }[c.Parameter] ?? '대상';
    const value = c.Parameter === 'School' ? data.labels.School[c.Value] : c.Parameter === 'ArmorType' ? data.labels.ArmorType[c.Value] : c.Parameter === 'Size' ? { Small: '소형', Medium: '중형', Large: '대형', XLarge: '초대형' }[c.Value] : '스킬에 지정된 대상';
    return `발동 조건: 대상 ${name}이 ${value ?? '스킬에 지정된 상태'} ${operand}`;
  }
  if (c.Type === 'Special') {
    const status = data.labels.BuffName[`Special_${c.Parameter}`] ?? '스킬의 특수 상태';
    return c.Operand === 'Exists' ? `발동 조건: ${status} ${c.Value ? '활성' : '비활성'} 상태` : `발동 조건: ${status} 단계가 ${c.Value} ${operand}`;
  }
  if (c.Type === 'BuffCount') return `발동 조건: ${data.labels.BuffName[c.Parameter] ?? '지정된 효과'} 중첩 ${Array.isArray(c.Value) ? c.Value.join('–') : c.Value}`;
  if (c.Type === 'SkillLevel') return `발동 조건: ${SKILL_NAMES[c.Parameter] ?? '지정된 스킬'} 레벨 ${Array.isArray(c.Value) ? c.Value.join('–') : c.Value}`;
  return '발동 조건: 스킬 설명에 지정된 조건을 확인하세요.';
}

function renderSkills() {
  const entries = skillOptions(student, normalizeBuild(student, build, currentRegion()));
  const entry = currentSkill();
  if (!entry) return;
  selectedSkill = entry.key;
  const parent = entry.parent ?? entry.key;
  const skill = entry.skill;
  const level = build.skills[parent] ?? 1;
  $('skill-tabs').innerHTML = entries.map(e => `<button type="button" role="tab" aria-selected="${e.key === entry.key}" tabindex="${e.key === entry.key ? 0 : -1}" data-skill="${escape(e.key)}">${escape(e.parent ? `${SKILL_NAMES[e.type]} · ${e.skill.Name ?? '추가 효과'}` : SKILL_NAMES[e.type])}</button>`).join('');
  $('skill-name').textContent = skill.Name ?? '일반 공격';
  options($('skill-level'), Array.from({ length: parent === 'Normal' ? 1 : parent === 'Ex' ? 5 : 10 }, (_, i) => [i + 1, i + 1]), level);
  $('skill-description').textContent = skillDescription(skill, level, data.labels);
  $('skill-meta').innerHTML = `${skill.Cost ? `<span>코스트 ${atLevel(skill.Cost, level)}</span>` : ''}<span>${SKILL_NAMES[entry.type]}</span>${entry.type === 'GearPublic' ? '<span>애용품 T2 반영</span>' : ''}`;
  const effects = skill.Effects ?? [];
  selectedEffect = Math.min(selectedEffect, Math.max(0, effects.length - 1));
  options($('effect-select'), effects.length ? effects.map((e, i) => [i, `${i + 1}. ${effectNames[e.Type] ?? e.Type}${e.Type === 'Damage' ? ` · ${(atLevel(e.Scale, level) / 100).toFixed(2)}%` : ''}${e.Condition ? ' · 조건부' : ''}${e.DescParamId ? ` · 설명 ${e.DescParamId}번` : ''}`]) : [[0, '계산 가능한 효과 데이터 없음']], selectedEffect);
  $('effect-select').disabled = !effects.length;
  const effect = effects[selectedEffect];
  $('effect-notes').textContent = effects.length > 1 ? '여러 효과는 서로 다른 대상·조건일 수 있습니다. 선택한 효과만 계산합니다.' : '선택한 효과가 적중했을 때의 1회 기준입니다.';
  $('condition-label').hidden = !effect?.Condition;
  $('condition-text').textContent = conditionDescription(effect?.Condition);
}

function renderStats() {
  const enemy = enemySettings();
  const calculated = currentContext(enemy)?.calculatedStudent ?? studentStats(student, build, data, enemy.attackBuff, enemy.critBuff);
  const stats = calculated.stats;
  $('stats').innerHTML = ['MaxHP', 'AttackPower', 'DefensePower', 'HealPower', 'CriticalPoint', 'CriticalDamageRate', 'AccuracyPoint', 'StabilityPoint'].map(stat => `<div class="stat"><span>${escape(data.labels.Stat[stat])}</span><strong>${stat === 'CriticalDamageRate' ? `${(stats[stat] / 100).toFixed(1)}<small>%</small>` : number(stats[stat])}</strong></div>`).join('');
  $('stat-notes').textContent = calculated.notes.join(' ') + (currentContext(enemy)?.inheritance.length ? ' 팀 스페셜의 지원 능력치를 포함합니다.' : '');
  if (document.querySelector('.growth-chart').open) renderChart();
}

function renderChart() {
  const enemy = enemySettings();
  const levels = Array.from({ length: currentRegion().StudentMaxLevel }, (_, i) => i + 1);
  const points = levels.map(level => studentStats(student, { ...build, level }, data, enemy.attackBuff, enemy.critBuff, currentContext()?.inheritance ?? []).stats);
  const width = 420, height = 135, pad = 20;
  const maxHP = Math.max(...points.map(s => s.MaxHP)), maxATK = Math.max(...points.map(s => s.AttackPower));
  const path = (stat, max) => points.map((s, i) => `${i ? 'L' : 'M'}${(pad + i / (points.length - 1) * (width - pad * 2)).toFixed(1)},${(height - pad - s[stat] / Math.max(max, 1) * (height - pad * 2)).toFixed(1)}`).join(' ');
  const text = levels.filter(level => [1, 15, 35, 60, 90].includes(level));
  $('level-chart').innerHTML = `<div class="chart-legend"><span><i style="background:#00a7de"></i>체력 (최대 ${number(maxHP)})</span><span><i style="background:#e2ac56"></i>공격 (최대 ${number(maxATK)})</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="레벨별 체력과 공격력. 각 수치의 최댓값을 100%로 표시.">${[0, 1, 2, 3].map(i => `<path d="M${pad},${pad + i * (height - pad * 2) / 3}H${width - pad}" stroke="#eaf1f5"/>`).join('')}<path d="${path('MaxHP', maxHP)}" fill="none" stroke="#00a7de" stroke-width="2.5"/><path d="${path('AttackPower', maxATK)}" fill="none" stroke="#e2ac56" stroke-width="2.5"/>${text.map(level => `<text x="${pad + (level - 1) / (points.length - 1) * (width - pad * 2)}" y="${height - 3}" text-anchor="middle" font-size="9" fill="#9aadb9">${level}</text>`).join('')}</svg>`;
}

function renderResult() {
  const entry = currentSkill();
  const effects = entry?.skill.Effects ?? [];
  const effect = effects[selectedEffect];
  const parent = entry?.parent ?? entry?.key;
  const level = build.skills[parent] ?? 1;
  const enemy = enemySettings();
  const result = combatResult(student, build, data, entry?.skill ?? {}, effect, level, { ...currentContext()?.enemy, ...enemy });
  if (!result.supported) {
    $('result-status').textContent = 'INFO';
    let title = '피해량 계산을 보류합니다.';
    let description = result.reasons.map(escape).join('<br>');
    if (effect && effect.Type !== 'Damage') {
      title = `${effectNames[effect.Type] ?? '특수'} 효과입니다.`;
      description = '직접 피해 효과가 아닙니다. 스킬 설명에서 선택 레벨의 수치를 확인하세요.';
      if (effect.Type === 'Heal' && !effect.Condition && effect.Scale) {
        const stats = currentContext()?.calculatedStudent.stats ?? studentStats(student, build, data, enemy.attackBuff, enemy.critBuff).stats;
        description += `<br><br>회복 보정 전 치유력 기준값 <strong>${number(stats.HealPower * atLevel(effect.Scale, level) / 10000)}</strong><br>회복 버프·대상 회복 효과는 제외한 참고값입니다.`;
      }
    }
    $('result').innerHTML = `<div class="result-empty"><h3>${title}</h3><p>${description}</p></div><p class="result-note">기본 공격 또는 직접 피해가 있는 스킬 효과를 선택하면 예상 피해량을 확인할 수 있습니다.</p>`;
    return;
  }
  $('result-status').textContent = 'LIVE';
  const grade = ['D', 'C', 'B', 'A', 'S', 'SS'][Math.min(result.affinity, 5)];
  $('result').innerHTML = `<p class="result-title">평균 예상 피해량</p><div class="result-value">${number(result.expected)}<small>DMG</small></div><p class="result-subtitle">${escape(entry.skill.Name ?? '일반 공격')} · Lv.${level} · 효과 ${selectedEffect + 1} · ${result.hitCount}타</p><div class="result-pair"><div><span>비치명 평균</span><strong>${number(result.nonCrit.avg)}</strong><small>${number(result.nonCrit.min)} – ${number(result.nonCrit.max)}</small></div><div><span>치명타 평균</span><strong>${number(result.crit.avg)}</strong><small>${number(result.crit.min)} – ${number(result.crit.max)}</small></div></div><div class="breakdown"><div><span>합산 스킬 계수</span><strong>${(result.scale / 100).toFixed(2)}%</strong></div><div><span>공격 상성</span><strong class="accent">${escape(data.labels.BulletType[student.BulletType])} → ${escape(data.labels.ArmorType[enemy.armor])} ×${result.effectiveness.toFixed(2)}</strong></div><div><span>지형 적성</span><strong>${grade} · ×${result.terrainMod.toFixed(2)}</strong></div><div><span>방어력 반영 후 배율</span><strong>×${result.defenseMod.toFixed(3)}</strong></div><div><span>레벨 차이 보정</span><strong>×${result.levelMod.toFixed(2)}</strong></div><div><span>치명 확률</span><strong>${percent(result.critRate)}</strong></div><div><span>명중 확률</span><strong>${percent(result.accuracy)}</strong></div><div><span>안정률 하한</span><strong>${percent(result.stability)}</strong></div></div><p class="result-note">평균 예상 피해량은 안정률에 따른 평균과 치명·명중 확률을 반영합니다. 범위는 명중했을 때의 값입니다. ${effect.Condition ? '이 효과의 발동 조건 충족을 가정합니다. ' : ''}원본 반복 타격은 모두 같은 입력 상태로 합산합니다. 시간별 버프 변화는 택틱에서 계산합니다. 적 엄폐·실드·기믹·조건부 추가 효과는 제외합니다.</p>`;
}

function update() {
  savedBuilds.set(student.Id, build);
  preparedTeam = prepareTeam(members(), data);
  contextForSelection = teamContext(members(), student.Id, {}, enemySettings(), data, true, preparedTeam);
  document.querySelectorAll('[data-growth-student]').forEach(el=>{const id=Number(el.dataset.growthStudent), b=id===student.Id?build:savedBuilds.get(id);if(b)el.textContent=`Lv.${b.level} · ${b.stars}성 · EX ${b.skills.Ex}`;});
  renderSkills(); renderStats(); renderResult(); tactic?.sync();
}

async function init() {
  try {
    const responses = await Promise.all([fetch('./data/global.json'), fetch('./data/raids.json')]);
    if (responses.some(r => !r.ok)) throw new Error('계산 데이터를 불러오지 못했습니다.');
    [data, raidData] = await Promise.all(responses.map(r => r.json()));
    if (data.meta.build !== raidData.meta.build) throw new Error('학생·보스 데이터 기준일이 다릅니다.');
    if (!data.students?.length) throw new Error('학생 목록이 비어 있습니다.');
    options($('school-filter'), [['', '모든 학원'], ...[...new Set(data.students.map(s => s.School))].map(s => [s, data.labels.School[s] ?? s]).sort((a, b) => a[1].localeCompare(b[1], 'ko'))], '');
    options($('type-filter'), [['', '모든 공격 타입'], ...Object.entries(data.labels.BulletType)], '');
    options($('skill-effect-filter'), [['', '모든 효과'], ...Object.entries(SKILL_FILTERS)], '');
    options($('enemy-armor'), Object.entries(data.labels.ArmorType), 'LightArmor');
    $('level').max = $('level-range').max = data.meta.region.StudentMaxLevel;
    $('max-level-label').textContent = `Lv. ${data.meta.region.StudentMaxLevel}`;
    const sourceDate = new Date(data.meta.build * 1000).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
    $('data-source').textContent = `출처: Schale DB · 한국어 데이터 / 총 ${data.meta.count}명 · 한국·글로벌 ${data.meta.globalCount}명 · 일본 전용 ${data.meta.japanOnlyCount}명 · 원본 빌드 ${sourceDate} (한국 시간). 최신 출시 여부는 이 데이터 기준이며 자동 갱신되지 않습니다.`;
    const id = location.hash.match(/^#student-(\d+)$/)?.[1];
    selectStudent(id ?? 10000, Boolean(id));
    renderRaid();
    tactic = new TacticUI(() => ({ data, raidData, members: members(), prepared: preparedTeam, enemy: enemySettings(),
      raid: activeRaid, battleKey: `${$('raid-mode').value}:${$('battle-server').value}`,
      difficulty: Number($('raid-difficulty').value) }));
    update();
    $('app-content').hidden = false;
  } catch (error) {
    $('load-error').hidden = false;
    $('load-error').textContent = `데이터를 불러오지 못했습니다. 로컬 서버로 접속했는지 확인하세요. (${error.message}) `;
    const retry = document.createElement('button'); retry.textContent = '다시 시도'; retry.className = 'quiet-button retry';
    retry.addEventListener('click', () => location.reload()); $('load-error').append(retry);
    $('student-list').innerHTML = '<p class="empty">데이터 로딩 실패</p>';
  }
}

for (const id of ['search', 'skill-search', 'school-filter', 'type-filter', 'release-filter', 'skill-effect-filter', 'skill-slot-filter', 'skill-target-filter']) $(id).addEventListener(['search','skill-search'].includes(id) ? 'input' : 'change', () => { if (data) renderRoster(); });
$('clear-search').addEventListener('click', () => {
  for (const id of ['search','skill-search','school-filter','type-filter','skill-effect-filter','skill-slot-filter','skill-target-filter']) $(id).value = '';
  $('release-filter').value = 'all'; if(data) renderRoster();
});
$('student-list').addEventListener('click', event => {
  const button = event.target.closest('[data-student]'); if (!button) return;
  const key = button.dataset.matchSkill, source = button.dataset.matchSource;
  selectStudent(button.dataset.student);
  if (key && !['GearPublic','WeaponPassive'].includes(source)) { selectedSkill=key; selectedEffect=0;update(); }
  $('search-skill-preview')?.remove();
  if (source === 'GearPublic' || source === 'WeaponPassive') {
    const skill=matchingSkills(student,data.labels,skillSearchSettings()).find(s=>s.source===source&&s.key===key)?.skill;
    const note=document.createElement('div');note.id='search-skill-preview';note.className='model-note';
    note.textContent=`${source==='GearPublic'?'애용품 T2':'고유무기 2성'} · ${skill?.Name}: ${skillDescription(skill,1,data.labels)} (Lv.1 기준)`;
    $('student-profile').after(note);
  }
});
$('workspace-tabs').addEventListener('click', event => { const button=event.target.closest('[data-workspace]'); if(button)setWorkspaceView(button.dataset.workspace); });
$('workspace-tabs').addEventListener('keydown', event => {
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=[...$('workspace-tabs').querySelectorAll('[data-workspace]')],index=tabs.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault();setWorkspaceView(tabs[next].dataset.workspace);tabs[next].focus();
});
document.querySelectorAll('[data-open-workspace]').forEach(button=>button.addEventListener('click',()=>setWorkspaceView(button.dataset.openWorkspace)));
$('team-slots').addEventListener('click', event => {
  const edit = event.target.closest('[data-team-edit]'), remove = event.target.closest('[data-team-remove]');
  if (edit) { selectStudent(teamIds[Number(edit.dataset.teamEdit)]); $('student-profile').scrollIntoView({block:'start'}); }
  if (remove) { teamIds[Number(remove.dataset.teamRemove)] = null; renderTeam(); update(); }
});
$('team-add').addEventListener('click', () => {
  const slot = Number($('team-position').value);
  if (teamIds.some((id, index) => index !== slot && id && data.students.find(s => s.Id === id).Name === student.Name)) {
    $('team-message').textContent = '이미 편성된 학생입니다. 같은 학생의 전투 스타일은 함께 편성할 수 없습니다.'; return;
  }
  teamIds[slot] = student.Id; savedBuilds.set(student.Id, build); $('team-message').textContent = `${student.Name} 편성 완료`;
  renderTeam(); update();
});
for (const id of ['raid-boss', 'raid-difficulty', 'raid-target','battle-server','drill-type']) $(id).addEventListener('change', () => { renderRaid(); update(); });
$('raid-mode').addEventListener('change',()=>setBattleMode($('raid-mode').value));
$('battle-tabs').addEventListener('click',event=>{const button=event.target.closest('[data-battle-mode]');if(button)setBattleMode(button.dataset.battleMode);});
$('battle-tabs').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=[...$('battle-tabs').querySelectorAll('[data-battle-mode]')],index=tabs.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault();setBattleMode(tabs[next].dataset.battleMode);tabs[next].focus();
});
$('student-list').addEventListener('error', event => { if (event.target.tagName === 'IMG') { event.target.removeAttribute('src'); event.target.style.visibility = 'hidden'; } }, true);
$('student-profile').addEventListener('error', event => { if (event.target.tagName === 'IMG') event.target.hidden = true; }, true);

const growthFields = { level: 'level', 'level-range': 'level', stars: 'stars', bond: 'bond', 'weapon-stars': 'weaponStars', 'weapon-level': 'weaponLevel', gear: 'gear', potential: 'potential' };
for (const [id, key] of Object.entries(growthFields)) {
  $(id).addEventListener(['level', 'level-range', 'bond', 'weapon-level', 'potential'].includes(id) ? 'input' : 'change', event => {
    if (!build || event.target.value === '') return;
    build[key] = Number(event.target.value);
    renderGrowth(); update();
  });
}
$('equipment-fields').addEventListener('change', event => { if (event.target.dataset.equipment !== undefined) { build.equipment[Number(event.target.dataset.equipment)] = Number(event.target.value); renderGrowth(); update(); } });
$('passive-enabled').addEventListener('change', () => { build.passive = $('passive-enabled').checked; update(); });
$('skill-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-skill]');
  if (!button) return;
  selectedSkill = button.dataset.skill; selectedEffect = 0; $('condition-assume').checked = false; update();
  [...$('skill-tabs').querySelectorAll('button')].find(b => b.dataset.skill === selectedSkill)?.focus({ preventScroll: true });
});
$('skill-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...$('skill-tabs').querySelectorAll('button')], index = tabs.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); tabs[next]?.click();
});
$('skill-level').addEventListener('change', () => { const entry = currentSkill(); build.skills[entry.parent ?? entry.key] = Number($('skill-level').value); update(); });
$('effect-select').addEventListener('change', () => { selectedEffect = Number($('effect-select').value); $('condition-assume').checked = false; update(); });
$('condition-assume').addEventListener('change', renderResult);
for (const [key, id] of Object.entries(enemyFields)) {
  $(id).addEventListener(['armor', 'terrain'].includes(key) ? 'change' : 'input', event => {
    if (!build || event.target.value === '') return;
    if (!['armor', 'terrain'].includes(key)) event.target.value = clamp(Number(event.target.value), Number(event.target.min), Number(event.target.max));
    if (['armor', 'terrain'].includes(key) && $('raid-mode').value !== 'custom') renderRaid();
    update();
  });
}
$('reset').addEventListener('click', () => {
  if (!data) return;
  const defaults = { armor: 'LightArmor', terrain: 'Street', level: data.meta.region.StudentMaxLevel, defense: 1000, critResist: 100, critDmgResist: 50 };
  for (const [key, id] of Object.entries(enemyFields)) $(id).value = defaults[key] ?? 0;
  savedBuilds.delete(student.Id); savedSelections.delete(student.Id); build = null;
  selectStudent(student.Id);
  renderRaid(); update();
});
document.querySelector('.growth-chart').addEventListener('toggle', event => { if (event.target.open && data) renderChart(); });
document.addEventListener('keydown', event => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); if($('workspace').dataset.view==='tactic')setWorkspaceView('students');$('search').focus(); } });
window.addEventListener('hashchange', () => { const match = location.hash.match(/^#student-(\d+)$/); if (match && data) selectStudent(match[1], false); });
init();
