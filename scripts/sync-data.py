"""Fetch Korean labels for global/Japanese students, raids and firing drills."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import urllib.request

BASE = 'https://schaledb.com/'
ROOT = Path(__file__).resolve().parent.parent
PATHS = ['data/kr/students.json', 'data/kr/equipment.json', 'data/kr/localization.json', 'data/config.json',
         'data/kr/raids.json', 'data/kr/enemies.json']


def fetch(path):
    request = urllib.request.Request(BASE + path, headers={'User-Agent': 'BlueLab/0.1 (personal simulator)'})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        fetched = list(pool.map(fetch, PATHS))
    students, equipment, localization, config, raids, enemies = [item[0] for item in fetched]
    region = next(r for r in config['Regions'] if r['Name'] == 'Global')
    fields = {'Id', 'Name', 'PathName', 'School', 'StarGrade', 'SquadType', 'TacticRole', 'Position', 'IsReleased',
              'BulletType', 'ArmorType', 'WeaponType', 'Equipment', 'Skills', 'Weapon', 'Gear',
              'FavorStatType', 'FavorStatValue', 'FavorAlts', 'StatLevelUpType', 'Transcendence',
              'ServerData', 'StatGlobal', 'Size', 'RegenCost', 'AttackSpeed', 'AmmoCount', 'AmmoCost'}
    selected = []
    for student in students.values():
        if not any(student['IsReleased'][:2]):
            continue
        selected.append({k: v for k, v in student.items()
                         if k in fields or k.endswith(('1', '100', 'Point', 'Rate', 'Adaptation'))})
    selected.sort(key=lambda s: s['Name'])
    gears = [{k: item[k] for k in ('Id', 'Category', 'Tier', 'Name', 'MaxLevel', 'StatType', 'StatValue')}
             for item in equipment.values()
             if any(item.get('IsReleased', [False, False])[:2]) and item.get('Tier', 0) > 0
             and item['Category'] in {'Hat', 'Gloves', 'Shoes', 'Bag', 'Badge', 'Hairpin', 'Charm', 'Watch', 'Necklace'}]
    assert selected and all(s['Skills'] and s['MaxHP1'] > 0 for s in selected)
    assert len({s['Id'] for s in selected}) == len(selected)
    data = {'meta': {'source': BASE, 'retrievedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                     'build': config['build'], 'region': region, 'count': len(selected),
                     'japanRegion': {k:v for k,v in config['Regions'][0].items() if k in {'Name','StudentMaxLevel','WeaponMaxLevel','BondMaxLevel','EquipmentMaxLevel','GearUnlock','GearBondReq','PotentialMax','UseNewCalculationLimit'}},
                     'globalCount': sum(s['IsReleased'][1] for s in selected),
                     'japanOnlyCount': sum(s['IsReleased'][0] and not s['IsReleased'][1] for s in selected),
                     'sourceHashes': dict(zip(PATHS, [item[1] for item in fetched]))},
            'students': selected, 'equipment': gears,
            'labels': {k: localization[k] for k in ('School', 'BulletType', 'ArmorType', 'Stat', 'BuffName')},
            'effectiveness': config['TypeEffectiveness'], 'limits': config['StatLimit']['Student']}
    raid_rows = []
    enemy_ids = set()
    for raid in raids['Raid']:
        if not any(raid['IsReleased'][:2]):
            continue
        row = {k: raid[k] for k in ('Id', 'Name', 'PathName', 'Terrain', 'ArmorType', 'EnemyList', 'RaidSkillList')}
        row['IsReleased'] = raid['IsReleased'][:2]
        row['MaxDifficultyByServer'] = raid['MaxDifficulty'][:2]
        row['MaxDifficulty'] = max(row['MaxDifficultyByServer'])
        row['Levels'] = raid.get('Level', [17, 25, 35, 50, 70, 80, 90, 90])
        row['BattleDuration'] = raid['BattleDuration']
        row['EnemyList'] = row['EnemyList'][:row['MaxDifficulty'] + 1]
        row['RaidSkillList'] = row['RaidSkillList'][:row['MaxDifficulty'] + 1]
        row['ExtraStats'] = raid.get('EnemyExtraStats', {})
        for server in (0, 1):
            variants = {}
            for season in raids['RaidSeasons'][server]['EliminateSeasons']:
                if season['RaidId'] != raid['Id']:
                    continue
                for armor, difficulty in season['OpenDifficulty'].items():
                    key = (season['Terrain'], armor)
                    variants[key] = max(variants.get(key, 0), min(difficulty, row['MaxDifficultyByServer'][server]))
            row['JapanEliminateVariants' if server == 0 else 'EliminateVariants'] = [
                {'Terrain': terrain, 'ArmorType': armor, 'MaxDifficulty': difficulty}
                for (terrain, armor), difficulty in variants.items()]
        enemy_ids.update(e for group in row['EnemyList'] for e in group)
        raid_rows.append(row)
    drills = []
    rule_ids = set()
    for drill in raids['TimeAttack']:
        if not any(drill['IsReleased'][:2]):
            continue
        row = {k:drill[k] for k in ('Id','IsReleased','DungeonType','Terrain','ArmorType','Level','Formations','Rules','BattleDuration','MaxDifficulty')}
        row['ExtraStats'] = drill.get('EnemyExtraStats', {})
        drills.append(row)
        enemy_ids.update(e for formation in row['Formations'] for e in formation['EnemyList'])
        rule_ids.update(r['Id'] for group in row['Rules'] for r in group)
    enemy_fields = {'Id', 'Name', 'Icon', 'ArmorType', 'BulletType', 'Rank', 'Size', 'StatLevelUpType',
                    'CriticalResistPoint', 'CriticalChanceResistPoint', 'CriticalDamageResistRate',
                    'DodgePoint', 'DefensePower1', 'DefensePower100', 'MaxHP1', 'MaxHP100', 'IsNPC', 'PhaseChange',
                    'AttackPower1', 'AttackPower100', 'HealPower1', 'HealPower100', 'AccuracyPoint', 'CriticalPoint', 'CriticalDamageRate',
                    'StabilityPoint', 'StabilityRate', 'Skills', 'Range', 'AmmoCount', 'AmmoCost',
                    'DamagedRatio', 'DamagedRatio2', 'ExDamagedRatio', 'ReduceWeakDamagedRate',
                    'WeakDamagedRatio', 'EffectiveDamagedRatio', 'NormalDamagedRatio', 'ResistDamagedRatio'}
    raid_data = {'meta': {'build': config['build'], 'source': BASE,
                         'sourceHashes': {path: digest for path, (_, digest) in zip(PATHS, fetched) if 'raids' in path or 'enemies' in path}},
                 'raids': raid_rows, 'drills': drills,
                 'drillRules': {str(r['Id']):r for r in raids['TimeAttackRules'] if r['Id'] in rule_ids},
                 'enemies': {str(e): {k: v for k, v in enemies['Enemies'][str(e)].items() if k in enemy_fields}
                                               for e in sorted(enemy_ids)},
                 'limits': {rank: config['StatLimit'].get(rank, {}) for rank in ('Boss', 'Champion', 'Elite', 'Minion')}}
    skill_ids = {key for enemy in raid_data['enemies'].values() for key in enemy.get('Skills', [])}
    raid_skill_ids = {key for raid in raid_rows for group in raid['RaidSkillList'] for key in group}
    raid_data['enemySkills'] = {k: v for k, v in enemies['Skills'].items() if k in skill_ids}
    raid_data['raidSkills'] = {k: v for k, v in raids['RaidSkills'].items() if k in raid_skill_ids}
    assert raid_rows and all(str(e) in raid_data['enemies'] for e in enemy_ids)
    target = ROOT / 'data' / 'global.json'
    target.parent.mkdir(exist_ok=True)
    pending = target.with_suffix('.json.tmp')
    pending.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    pending.replace(target)
    raid_target = target.with_name('raids.json')
    raid_pending = raid_target.with_suffix('.json.tmp')
    raid_pending.write_text(json.dumps(raid_data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    raid_pending.replace(raid_target)
    print(f'Students: {len(selected)} total, {data["meta"]["japanOnlyCount"]} Japan only, {target.stat().st_size:,} bytes')
    print(f'Drills: {len(drills)} rounds, {len(rule_ids)} referenced rules')
    print(f'Raids: {len(raid_rows)} bosses, {len(enemy_ids)} enemy entries, {raid_target.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
