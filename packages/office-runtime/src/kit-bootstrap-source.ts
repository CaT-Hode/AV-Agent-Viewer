/** A docless, versioned registration seed. It never contains a live Office profile. */
export const officeKitBootstrapSource = String.raw`
import shutil, stat
KIT_BOOTSTRAP_BUILD='bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1'
KIT_BOOTSTRAP_DLL='017d0c21b6e45e54c0194b58017853d8c653059cc643643c3eb831a4d309331f'
KIT_BOOTSTRAP_SETUP=b'<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Setup/Office"><prop oor:name="LastCompatibilityCheckID" oor:op="fuse"><value>'+KIT_BOOTSTRAP_BUILD.encode()+b'</value></prop><prop oor:name="ooSetupInstCompleted" oor:op="fuse"><value>true</value></prop></item></oor:items>'

def bootstrap_registration_fingerprint(program):
    # Relative inventory plus the complete registration metadata, independent
    # of installation path and copy timestamps. Dictionaries are read directly
    # from the installed engine; their contents never enter this seed.
    digest=hashlib.sha256(KIT_BOOTSTRAP_BUILD.encode())
    def checked_info(path,info):
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0):raise ValueError('Bootstrap catalog link')
        return info
    share=program.parent/'share'
    try:share_info=checked_info(share,share.stat(follow_symlinks=False))
    except FileNotFoundError:share_info=None
    if share_info is not None and not stat.S_ISDIR(share_info.st_mode):raise ValueError('Bootstrap catalog root')
    for directory in ['share/extensions','share/uno_packages']:
        root=program.parent/directory
        if share_info is None:digest.update((directory+'/absent\n').encode());continue
        try:root_info=checked_info(root,root.stat(follow_symlinks=False))
        except FileNotFoundError:digest.update((directory+'/absent\n').encode());continue
        if not stat.S_ISDIR(root_info.st_mode):raise ValueError('Bootstrap catalog root')
        if '__pycache__' in root.parts:continue
        files=[]
        def scan(path):
            with os.scandir(path) as entries:
                for entry in entries:
                    info=checked_info(entry.path,entry.stat(follow_symlinks=False));name=entry.name;suffix=os.path.splitext(name)[1].lower()
                    if name=='__pycache__':continue
                    if stat.S_ISDIR(info.st_mode):scan(pathlib.Path(entry.path))
                    elif stat.S_ISREG(info.st_mode) and suffix not in ['.pyc','.pyo'] and not name.lower().endswith('.log'):files.append((pathlib.Path(entry.path),info.st_size))
        scan(root)
        # Preserve the original Path ordering, including Windows component-wise
        # case folding. Plain relative-string sorting is a different inventory.
        for path,size in sorted(files,key=lambda item:item[0]):
            relative=path.relative_to(root).as_posix();metadata=path.suffix.lower() in ['.xml','.xcu','.xcs','.rdb','.components','.ini','.json'] or path.name in ['manifest','unorc']
            digest.update(json.dumps([directory,relative,size,hashlib.sha256(path.read_bytes()).hexdigest() if metadata else None],ensure_ascii=False,separators=(',',':')).encode()+b'\n')
    return digest.hexdigest()

def bootstrap_allowed_file(name):
    if not isinstance(name,str) or '\\' in name:return False
    parts=pathlib.PurePosixPath(name).parts
    if not parts or name!=pathlib.PurePosixPath(name).as_posix() or any(part in ['.','..'] for part in parts):return False
    return name=='user/registrymodifications.xcu' or name=='user/extensions/buildid' or len(parts)>3 and parts[:3] in [('user','extensions','bundled'),('user','extensions','shared')] and parts[-1].lower() not in ['.lock','lock'] and not parts[-1].lower().endswith('.log')

def bootstrap_read_seed(directory,catalog):
    directory=pathlib.Path(directory).resolve();manifest_path=directory/'manifest.json'
    if not manifest_path.is_file() or manifest_path.is_symlink() or manifest_path.stat().st_size>512*1024:raise ValueError('Bootstrap manifest missing')
    manifest=json.loads(manifest_path.read_text('utf-8'))
    if not isinstance(manifest,dict):raise ValueError('Bootstrap manifest shape')
    if manifest.get('schemaVersion')!=1 or manifest.get('engineBuildId')!=KIT_BOOTSTRAP_BUILD or manifest.get('mergedloSha256')!=KIT_BOOTSTRAP_DLL or manifest.get('registrationCatalogSha256')!=catalog or manifest.get('pathMode')!='registration-macros':raise ValueError('Bootstrap engine/catalog mismatch')
    records=manifest.get('files');files={};total=0
    if not isinstance(records,list) or not 1<=len(records)<=2048:raise ValueError('Bootstrap file count')
    for record in records:
        if not isinstance(record,dict):raise ValueError('Bootstrap file record shape')
        name=record.get('path');size=record.get('bytes')
        if not bootstrap_allowed_file(name) or name in files or type(size) is not int or not 0<=size<=16*1024*1024:raise ValueError('Bootstrap file bounds')
        blob=record.get('blob')
        if not isinstance(blob,str) or not re.fullmatch(r'payload/[0-9a-f]{32}',blob):raise ValueError('Bootstrap blob identity')
        path=directory/blob
        if not path.is_file() or path.is_symlink() or path.resolve().is_relative_to(directory) is False or path.stat().st_size!=size:raise ValueError('Bootstrap file identity')
        data=path.read_bytes();total+=len(data)
        if total>16*1024*1024 or hashlib.sha256(data).hexdigest()!=record.get('sha256'):raise ValueError('Bootstrap file checksum')
        if name=='user/registrymodifications.xcu' and data!=KIT_BOOTSTRAP_SETUP:raise ValueError('Bootstrap preference outside allowlist')
        if re.search(rb'file:///|(?:^|[\s"\'=])[A-Za-z]:[/\\]',data,re.IGNORECASE):raise ValueError('Bootstrap absolute path')
        files[name]=data
    if files.get('user/extensions/buildid',b'').strip()!=KIT_BOOTSTRAP_BUILD.encode() or files.get('user/registrymodifications.xcu')!=KIT_BOOTSTRAP_SETUP or 'user/extensions/bundled/lastsynchronized' not in files:raise ValueError('Bootstrap incomplete registration')
    return manifest,files

def prepare_bootstrap_profile():
    profile=pathlib.Path(tempfile.gettempdir())/('av-kit-profile-'+uuid.uuid4().hex[:12]);profile.mkdir()
    context={'profile':profile,'ready':False}
    try:
        catalog=bootstrap_registration_fingerprint(PROGRAM);cache_root=ROOT.parent/'kit-seed';cache=cache_root/catalog[:20]
        context.update(catalog=catalog,cache=cache,cacheRoot=cache_root)
        candidates=[cache]
        if config.get('bootstrapSeedPath'):candidates.append(pathlib.Path(config['bootstrapSeedPath']))
        for candidate in candidates:
            if not (candidate/'manifest.json').exists():continue
            try:
                manifest,files=bootstrap_read_seed(candidate,catalog)
                for name,data in files.items():
                    destination=profile/name;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data)
                context.update(ready=True,manifest=manifest,source=str(candidate),seedDirectory=candidate)
                emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_SEED_REUSED'});break
            except (OSError,ValueError,TypeError,KeyError):emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_SEED_REJECTED'})
    except (OSError,ValueError):emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_CACHE_UNAVAILABLE'})
    return context

def publish_docless_bootstrap_seed(context):
    # Called once, after actual engine/version initialization and before the
    # first document can be loaded. Never copy registry, history, credentials,
    # recovery records, device/OpenCL caches, locks or user package repositories.
    if sessions or desktop.getComponents().createEnumeration().hasMoreElements():raise ValueError('Bootstrap requires a docless engine')
    if context.get('ready'):return
    if 'catalog' not in context:return
    profile=context['profile'];files={'user/registrymodifications.xcu':KIT_BOOTSTRAP_SETUP}
    for path in sorted((profile/'user/extensions').rglob('*')):
        if not path.is_file():continue
        name=path.relative_to(profile).as_posix()
        if not bootstrap_allowed_file(name):continue
        if path.is_symlink() or path.resolve().is_relative_to(profile) is False:raise ValueError('Bootstrap source link')
        data=path.read_bytes()
        for root in [profile,PROGRAM]:
            for value in [str(root),root.as_posix(),root.as_uri()]:
                if any(value.encode(encoding).lower() in data.lower() for encoding in ['utf-8','utf-16le']):raise ValueError('Bootstrap source absolute path')
        files[name]=data
    manifest={'schemaVersion':1,'engineBuildId':KIT_BOOTSTRAP_BUILD,'mergedloSha256':KIT_BOOTSTRAP_DLL,'registrationCatalogSha256':context['catalog'],'pathMode':'registration-macros','files':[{'path':name,'blob':'payload/'+hashlib.sha256(data).hexdigest()[:32],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()} for name,data in sorted(files.items())]}
    context['cacheRoot'].mkdir(parents=True,exist_ok=True);staging=context['cacheRoot']/('seed-'+uuid.uuid4().hex[:12]);staging.mkdir()
    try:
        for record in manifest['files']:destination=staging/record['blob'];destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(files[record['path']])
        (staging/'manifest.json').write_text(json.dumps(manifest,separators=(',',':')),'utf-8');bootstrap_read_seed(staging,context['catalog'])
        if context['cache'].exists():
            try:bootstrap_read_seed(context['cache'],context['catalog']);context.update(ready=True,manifest=manifest,seedDirectory=context['cache']);return
            except (OSError,ValueError,TypeError,KeyError):
                # Preserve a rejected app cache for inspection; never delete or
                # rewrite an arbitrary live profile in the repair path.
                context['cache'].rename(context['cacheRoot']/('rejected-'+uuid.uuid4().hex))
        try:staging.rename(context['cache'])
        except FileExistsError:bootstrap_read_seed(context['cache'],context['catalog'])
        context.update(ready=True,manifest=manifest,seedDirectory=context['cache']);emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_SEED_READY'})
    finally:
        if staging.exists() and staging.resolve().parent==context['cacheRoot'].resolve() and staging.name.startswith('seed-'):shutil.rmtree(staging)
`;
