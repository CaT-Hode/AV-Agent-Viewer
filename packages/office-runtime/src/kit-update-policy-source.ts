/** The embedded engine is pinned and updated with AgentViewer, not by Office. */
export const officeKitUpdatePolicySource = String.raw`
import stat

def prepare_kit_update_policy(context):
    # Only the fresh profile created by prepare_bootstrap_profile is writable.
    # Never resolve a configured/global LibreOffice profile or edit the engine.
    profile=context['profile'];info=profile.stat(follow_symlinks=False)
    if profile.parent.resolve()!=pathlib.Path(tempfile.gettempdir()).resolve() or not re.fullmatch(r'av-kit-profile-[0-9a-f]{12}',profile.name) or context.get('profileIdentity')!=(info.st_dev,info.st_ino) or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0):raise ValueError('Office update policy requires the owned private profile')
    user=profile/'user';user.mkdir(exist_ok=True)
    for path in [user,user/'registrymodifications.xcu']:
        try:info=path.stat(follow_symlinks=False)
        except FileNotFoundError:continue
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0) or (not stat.S_ISDIR(info.st_mode) if path==user else not stat.S_ISREG(info.st_mode)):raise ValueError('Office update policy profile link/type')
    path=user/'registrymodifications.xcu'
    namespace='http://openoffice.org/2001/registry';tag=lambda name:'{'+namespace+'}'+name
    root=ET.fromstring(path.read_bytes()) if path.exists() else ET.Element(tag('items'))
    if root.tag!=tag('items'):raise ValueError('Office update policy registry root')
    root.set('xmlns:xs','http://www.w3.org/2001/XMLSchema')
    location='/org.openoffice.Office.Jobs'
    matches=[item for item in root.findall('item') if item.get(tag('path'))==location]
    item=matches[-1] if matches else ET.SubElement(root,'item',{tag('path'):location})
    # This private override must follow any more specific entries restored from
    # the registration seed. Retain unrelated jobs, properties and preferences.
    root.remove(item);root.append(item)
    def node(parent,name):
        matches=[child for child in parent.findall('node') if child.get(tag('name'))==name]
        child=matches[-1] if matches else ET.SubElement(parent,'node',{tag('name'):name})
        child.set(tag('op'),'fuse');return child
    arguments=node(node(node(item,'Jobs'),'UpdateCheck'),'Arguments')
    for prop in list(arguments):
        if prop.tag=='prop' and prop.get(tag('name'))=='AutoCheckEnabled':arguments.remove(prop)
    prop=ET.SubElement(arguments,'prop',{tag('name'):'AutoCheckEnabled',tag('op'):'fuse',tag('type'):'xs:boolean'});ET.SubElement(prop,'value').text='false'
    # Pinned LO bf6ef266: UpdateCheckJob::execute creates the initialization
    # thread unconditionally, before AutoCheckEnabled is consulted. Removing
    # only this event binding prevents both the 25-second init and its updater
    # thread. Keep Jobs/UpdateCheck and its manual UNO service registered.
    # extensions/source/update/check/updatecheckjob.cxx:163-202;
    # framework/source/jobs/jobdata.cxx:418-476; share/registry/onlineupdate.xcd.
    binding=node(node(node(node(item,'Events'),'onFirstVisibleTask'),'JobList'),'UpdateCheck')
    binding.clear();binding.set(tag('name'),'UpdateCheck');binding.set(tag('op'),'remove')
    temporary=path.with_name('.registrymodifications-'+uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('xb') as stream:stream.write(ET.tostring(root,encoding='utf-8',xml_declaration=True))
        os.replace(temporary,path)
    finally:
        if temporary.exists():temporary.unlink()
    context['updatePolicy']={'automaticJobEnabled':False,'automaticCheckEnabled':False}
`;
