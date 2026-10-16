/** Private UI translations only. Base settings, document locales and dictionaries stay installed.
 * Pinned FULL_INIT calls setLanguageAndLocale("en-US") in desktop/source/lib/init.cxx:8347.
 * CONFIGURATION_LAYERS is read from the environment before ordinary ini values (sal/rtl/bootstrap.cxx).
 * Invoke after preparing the private profile and before the first hook/UNO/configuration call.
 */
export const officeKitLocaleResourceSource = String.raw`
import hashlib, json, os, pathlib, re, shutil, stat, uuid
import xml.etree.ElementTree as ET

KIT_UI_RESOURCE_BUILD='bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1'
KIT_UI_RESOURCE_SCHEMA=1
KIT_UI_RESOURCE_DEFAULT='en-US'
KIT_UI_RESOURCE_OVERRIDE_KEYS=('CONFIGURATION_LAYERS','URE_BOOTSTRAP','INIFILENAME','BRAND_BASE_DIR','BRAND_INI_DIR','UNO_SERVICES','UNO_TYPES','UserInstallation','LOK_LANGUAGE','LOK_LOCALE','LOK_UI_LOCALE','SAL_LOCALE','UILocale','ooSetupUILocale')

def kit_ui_checked_path(path, directory=False):
    info=path.stat(follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0):raise ValueError('UI resource link')
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):raise ValueError('UI resource path type')
    return info

def kit_ui_bytes(path, limit):
    info=kit_ui_checked_path(path)
    if info.st_size>limit:raise ValueError('UI resource file bound')
    value=path.read_bytes()
    after=kit_ui_checked_path(path)
    if len(value)!=info.st_size or (info.st_size,info.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('UI resource source changed')
    return value

def kit_ui_default_locale(profile):
    # The pinned hook forces BOTH native UI and locale to en-US. Do not infer
    # this from document text, OS language, translation target or app theme.
    # A conflicting explicit private-profile preference is not ours to erase.
    path=profile/'user/registrymodifications.xcu'
    if path.exists():
        root=ET.fromstring(kit_ui_bytes(path,2*1024*1024))
        ns='{http://openoffice.org/2001/registry}'
        for prop in root.iter():
            if prop.tag.rsplit('}',1)[-1]!='prop' or prop.get(ns+'name') not in ('ooSetupUILocale','ooLocale','ooSetupSystemLocale'):continue
            values=[child for child in prop if child.tag.rsplit('}',1)[-1]=='value']
            if len(values)!=1 or values[0].text!=KIT_UI_RESOURCE_DEFAULT:raise ValueError('Unknown explicit UI locale')
    return KIT_UI_RESOURCE_DEFAULT

def kit_ui_resource_catalog(program):
    engine=program.parent;registry=engine/'share/registry';resources=registry/'res'
    for path in (engine,program,engine/'share',registry,resources):kit_ui_checked_path(path,True)
    if os.path.lexists(program/'fundamental.override.ini'):raise ValueError('Higher priority bootstrap override')
    version=kit_ui_bytes(program/'version.ini',256*1024).decode('utf-8-sig')
    builds=[match[1] for line in version.splitlines() if (match:=re.fullmatch(r'buildid=(.+)',line,re.IGNORECASE))]
    if builds!=[KIT_UI_RESOURCE_BUILD]:raise ValueError('Unverified UI resource engine')
    fundamental=kit_ui_bytes(program/'fundamental.ini',256*1024)
    definitions=[match[1] for line in fundamental.decode('utf-8-sig').splitlines() if (match:=re.fullmatch(r'CONFIGURATION_LAYERS=(.+)',line))]
    if len(definitions)!=1:raise ValueError('Unknown configuration layers')
    layers=definitions[0];token='res:$'+'{BRAND_BASE_DIR}/share/registry'
    if layers.split(' ').count(token)!=1 or sum(part.startswith('res:') for part in layers.split(' '))!=1:raise ValueError('Unknown UI resource layer')
    records=[];families={'registry':set(),'fcfg_langpack':set()};total=0
    for path in sorted(resources.iterdir(),key=lambda item:item.name):
        match=re.fullmatch(r'(registry|fcfg_langpack)_([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.xcd',path.name)
        if not match:raise ValueError('Unknown UI resource catalog file')
        data=kit_ui_bytes(path,16*1024*1024);total+=len(data)
        if total>256*1024*1024 or len(records)>=4096:raise ValueError('UI resource catalog bound')
        families[match[1]].add(match[2]);records.append({'path':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    locales=families['fcfg_langpack']
    if KIT_UI_RESOURCE_DEFAULT not in locales or (families['registry']-locales) or (locales-families['registry']) not in (set(),{KIT_UI_RESOURCE_DEFAULT}):raise ValueError('Incomplete UI locale catalog')
    identity={'engineBuildId':KIT_UI_RESOURCE_BUILD,'fundamentalSha256':hashlib.sha256(fundamental).hexdigest(),'files':records}
    return {'directory':resources,'layers':layers,'token':token,'records':records,'locales':locales,'sha256':hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode()).hexdigest()}

def kit_ui_selected_locales(catalog, locale):
    # Current proven native default is English. Keep all installed English
    # variants, including en-US fallback. Unknown future locale/fallback rules
    # use the complete original layer until independently supported.
    if locale!=KIT_UI_RESOURCE_DEFAULT or locale not in catalog['locales']:raise ValueError('Unknown native UI locale chain')
    return sorted(value for value in catalog['locales'] if value.split('-')[0]=='en')

def kit_ui_read_cache(directory, expected):
    kit_ui_checked_path(directory,True)
    if {path.name for path in directory.iterdir()}!={'manifest.json','res'}:raise ValueError('UI cache directory shape')
    manifest=json.loads(kit_ui_bytes(directory/'manifest.json',2*1024*1024))
    if not isinstance(manifest,dict) or manifest!=expected:raise ValueError('UI cache manifest mismatch')
    resources=directory/'res';kit_ui_checked_path(resources,True)
    if {path.name for path in resources.iterdir()}!={record['path'] for record in expected['files']}:raise ValueError('UI cache inventory mismatch')
    for record in expected['files']:
        value=kit_ui_bytes(resources/record['path'],16*1024*1024)
        if len(value)!=record['bytes'] or hashlib.sha256(value).hexdigest()!=record['sha256']:raise ValueError('UI cache checksum mismatch')

def prepare_kit_locale_resources(profile):
    # Failure is an optimization miss: leave the original complete layer and
    # all environment values intact. Never repair an installed engine/profile.
    context={'applied':False,'reason':'unavailable'};staging=None;cache_root=None
    try:
        if any(key in os.environ for key in KIT_UI_RESOURCE_OVERRIDE_KEYS):return {'applied':False,'reason':'explicit-override'}
        locale=kit_ui_default_locale(pathlib.Path(profile));catalog=kit_ui_resource_catalog(PROGRAM);locales=kit_ui_selected_locales(catalog,locale)
        selected=[record for record in catalog['records'] if re.fullmatch(r'(?:registry|fcfg_langpack)_(.*)\.xcd',record['path'])[1] in locales]
        manifest={'schemaVersion':KIT_UI_RESOURCE_SCHEMA,'engineBuildId':KIT_UI_RESOURCE_BUILD,'sourceCatalogSha256':catalog['sha256'],'uiLocale':locale,'loadedLocales':locales,'files':selected}
        key=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        parent=ROOT.parent.resolve();engine=PROGRAM.parent.resolve()
        if parent==engine or parent.is_relative_to(engine) or engine.is_relative_to(parent):raise ValueError('UI cache overlaps engine')
        kit_ui_checked_path(parent,True);cache_root=parent/'kit-ui-resources'
        cache_root.mkdir(exist_ok=True);kit_ui_checked_path(cache_root,True);destination=cache_root/key
        if destination.exists():kit_ui_read_cache(destination,manifest)
        else:
            staging=cache_root/('staging-'+uuid.uuid4().hex);staging.mkdir();(staging/'res').mkdir()
            for record in selected:
                data=kit_ui_bytes(catalog['directory']/record['path'],16*1024*1024)
                if len(data)!=record['bytes'] or hashlib.sha256(data).hexdigest()!=record['sha256']:raise ValueError('UI source changed during copy')
                (staging/'res'/record['path']).write_bytes(data)
            (staging/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,separators=(',',':')),'utf-8')
            kit_ui_read_cache(staging,manifest)
            try:staging.rename(destination);staging=None
            except FileExistsError:kit_ui_read_cache(destination,manifest)
            kit_ui_read_cache(destination,manifest)
        # A concurrent/foreign caller's bootstrap choice always takes priority.
        if any(key in os.environ for key in KIT_UI_RESOURCE_OVERRIDE_KEYS):return {'applied':False,'reason':'explicit-override'}
        layers=catalog['layers'].split(' ');layers[layers.index(catalog['token'])]='res:'+destination.as_uri()
        os.environ['CONFIGURATION_LAYERS']=' '.join(layers)
        return {'applied':True,'uiLocale':locale,'loadedLocales':locales,'sourceCatalogSha256':catalog['sha256'],'directory':str(destination),'resourceBytes':sum(record['bytes'] for record in selected)}
    except (OSError,ValueError,TypeError,KeyError,UnicodeError,ET.ParseError):return context
    finally:
        if staging is not None and cache_root is not None and staging.parent.resolve()==cache_root.resolve() and staging.name.startswith('staging-') and not staging.is_symlink():
            try:
                kit_ui_checked_path(staging,True);shutil.rmtree(staging)
            except (OSError,ValueError):pass
`;
