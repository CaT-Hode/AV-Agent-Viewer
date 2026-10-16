/** Written only into each worker's fresh private profile, before VCL initializes. */
export const nativeOfficeAppearanceProfileSource = String.raw`
def checked_native_appearance(value):
    if not isinstance(value,dict) or value.get('theme') not in ['light','dark'] or type(value.get('canvasColor')) is not int or not 0<=value['canvasColor']<=0xffffff:fail('INVALID_NATIVE_APPEARANCE','Office 显示配置无效。')
    paper=value.get('paperColor',0xffffff)
    if type(paper) is not int or not 0<=paper<=0xffffff:fail('INVALID_NATIVE_APPEARANCE','Office 纸面颜色无效。')
    return {'theme':value['theme'],'canvasColor':value['canvasColor'],'paperColor':paper}

def native_appearance_scheme(theme):return 'COLOR_SCHEME_LIBREOFFICE_'+theme.upper()

def prepare_native_appearance_profile(profile,value):
    value=checked_native_appearance(value);path=profile/'user/registrymodifications.xcu';path.parent.mkdir(parents=True,exist_ok=True)
    namespace='http://openoffice.org/2001/registry';tag=lambda name:'{'+namespace+'}'+name
    root=ET.fromstring(path.read_bytes()) if path.exists() else ET.Element(tag('items'))
    for location,values in [('/org.openoffice.Office.Common/Appearance',{'ApplicationAppearance':2 if value['theme']=='dark' else 1,'UseOnlyWhiteDocBackground':value['paperColor']==0xffffff,'UseBmpForAppBack':False}),('/org.openoffice.Office.UI/ColorScheme',{'CurrentColorScheme':native_appearance_scheme(value['theme'])})]:
        item=ET.SubElement(root,'item',{tag('path'):location})
        for name,setting in values.items():
            prop=ET.SubElement(item,'prop',{tag('name'):name,tag('op'):'fuse'});ET.SubElement(prop,'value').text=str(setting).lower() if type(setting) is bool else str(setting)
    path.write_bytes(ET.tostring(root,encoding='utf-8',xml_declaration=True))
`;

/** Changes only private application/view settings, never document content. */
export const nativeOfficeAppearanceSource = nativeOfficeAppearanceProfileSource + String.raw`
native_appearance=None

def sync_native_view_appearance(view,value=None):
    value=value or native_appearance
    if value is None or view.get('disposed'):return
    # ChangeTheme uses MiscSettings::SetAppColorMode (native frame dark-mode
    # state) and ColorConfig notifications. Writing ApplicationAppearance alone
    # leaves Win32's native control backgrounds and VCL text colours out of sync.
    # Kit deliberately updates only the current ViewShell, so every view needs
    # this read-only application command, including a newly attached view.
    owner=sessions.get(view.get('sessionId')) if 'kitViewId' in view else None
    previous=doc_call(owner,'getView',I)() if owner is not None else None
    if owner is not None:doc_call(owner,'setView',None,I)(view['kitViewId'])
    try:dispatcher.executeDispatch(view['frame'],'.uno:ChangeTheme','',0,props({'NewTheme':native_appearance_scheme(value['theme']),'SynchronMode':True}))
    finally:
        if owner is not None and previous>=0 and previous!=view['kitViewId']:doc_call(owner,'setView',None,I)(previous)

def apply_native_appearance(value):
    global native_appearance
    value=checked_native_appearance(value);paper=value['paperColor']
    provider=sm.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider',ctx)
    appearance=provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationUpdateAccess',props({'nodepath':'/org.openoffice.Office.Common/Appearance'}))
    appearance.setPropertyValue('ApplicationAppearance',uno.Any('short',2 if value['theme']=='dark' else 1))
    appearance.setPropertyValue('UseOnlyWhiteDocBackground',paper==0xffffff)
    appearance.setPropertyValue('UseBmpForAppBack',False)
    appearance.commitChanges()
    colors=provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationUpdateAccess',props({'nodepath':'/org.openoffice.Office.UI/ColorScheme'}))
    schemes=colors.getByName('ColorSchemes');name=native_appearance_scheme(value['theme'])
    if not schemes.hasByName(name):fail('NATIVE_APPEARANCE_UNAVAILABLE','当前 Office 配色方案不可用。')
    colors.setPropertyValue('CurrentColorScheme',name);colors.commitChanges()
    for session in sessions.values():
        if session.get('disposed') or session.get('unavailable'):continue
        for view in session['views'].values():sync_native_view_appearance(view,value)
    # Theme changes may restore scheme defaults. Apply the independent paper
    # and surrounding canvas last; neither setting changes a document's model.
    scheme=schemes.getByName(name)
    scheme.getByName('DocColor').setPropertyValue('Color',paper)
    scheme.getByName('AppBackground').setPropertyValue('Color',value['canvasColor'])
    colors.commitChanges()
    native_appearance=value
    for session in sessions.values():
        for view in session['views'].values():
            view['layoutRevision']+=1;view.pop('captureCache',None);view.pop('accessibilityCache',None)
    return {'theme':value['theme'],'canvasColor':value['canvasColor'],'paperColor':paper,'whiteDocumentBackground':paper==0xffffff}
`;
