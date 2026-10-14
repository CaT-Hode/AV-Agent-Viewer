/** Changes only the application's private UNO profile, never the document model. */
export const nativeOfficeAppearanceSource = String.raw`
def apply_native_appearance(value):
    if not isinstance(value,dict) or value.get('theme') not in ['light','dark'] or type(value.get('canvasColor')) is not int or not 0<=value['canvasColor']<=0xffffff:fail('INVALID_NATIVE_APPEARANCE','Office 显示配置无效。')
    paper=value.get('paperColor',0xffffff)
    if type(paper) is not int or not 0<=paper<=0xffffff:fail('INVALID_NATIVE_APPEARANCE','Office 纸面颜色无效。')
    provider=sm.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider',ctx)
    appearance=provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationUpdateAccess',props({'nodepath':'/org.openoffice.Office.Common/Appearance'}))
    appearance.setPropertyValue('ApplicationAppearance',uno.Any('short',2 if value['theme']=='dark' else 1))
    appearance.setPropertyValue('UseOnlyWhiteDocBackground',paper==0xffffff)
    appearance.setPropertyValue('UseBmpForAppBack',False)
    appearance.commitChanges()
    colors=provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationUpdateAccess',props({'nodepath':'/org.openoffice.Office.UI/ColorScheme'}))
    schemes=colors.getByName('ColorSchemes');name=colors.getPropertyValue('CurrentColorScheme')
    if not schemes.hasByName(name):fail('NATIVE_APPEARANCE_UNAVAILABLE','当前 Office 配色方案不可用。')
    scheme=schemes.getByName(name)
    scheme.getByName('DocColor').setPropertyValue('Color',paper)
    scheme.getByName('AppBackground').setPropertyValue('Color',value['canvasColor'])
    colors.commitChanges()
    for session in sessions.values():
        for view in session['views'].values():
            view['layoutRevision']+=1;view.pop('captureCache',None);view.pop('accessibilityCache',None)
    return {'theme':value['theme'],'canvasColor':value['canvasColor'],'paperColor':paper,'whiteDocumentBackground':paper==0xffffff}
`;
