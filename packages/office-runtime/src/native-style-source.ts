/** Typed styles for actual native selections. No document-wide or first-object fallback. */
export const nativeOfficeStyleSource = String.raw`
STYLE_TEXT_FIELDS=('fontFamily','fontSize','bold','italic','underline','strike','color','highlight')
STYLE_FIELDS={'text':STYLE_TEXT_FIELDS,'paragraph':('alignment','left','right','firstLine','top','bottom','lineSpacingPercent'),'cells':STYLE_TEXT_FIELDS+('alignment','verticalAlignment','wrap','fill','numberFormat'),'shape':('x','y','width','height','rotation','fill','lineColor','lineWidth')}
STYLE_SCRIPT_PROPERTIES={'fontFamily':('CharFontName','CharFontNameAsian','CharFontNameComplex'),'fontSize':('CharHeight','CharHeightAsian','CharHeightComplex'),'bold':('CharWeight','CharWeightAsian','CharWeightComplex'),'italic':('CharPosture','CharPostureAsian','CharPostureComplex')}
STYLE_PROPERTIES={'underline':'CharUnderline','strike':'CharStrikeout','color':'CharColor','highlight':'CharBackColor','left':'ParaLeftMargin','right':'ParaRightMargin','firstLine':'ParaFirstLineIndent','top':'ParaTopMargin','bottom':'ParaBottomMargin','lineSpacingPercent':'ParaLineSpacing','verticalAlignment':'VertJustify','wrap':'IsTextWrapped','numberFormat':'NumberFormat','rotation':'RotateAngle','lineColor':'LineColor','lineWidth':'LineWidth'}
STYLE_COLOR_DEPENDENCIES={'FillColor':('FillColorTheme','FillColorLumMod','FillColorLumOff','FillComplexColor'),'LineColor':('LineComplexColor',),'CharColor':('CharColorTheme','CharColorTintOrShade','CharColorLumMod','CharColorLumOff','CharComplexColor')}
STYLE_COMPLEX_COLORS={'FillComplexColor':'FillColor','LineComplexColor':'LineColor','CharComplexColor':'CharColor'}
STYLE_COLOR_GRAB_KEYS={'fill':('SpPrSolidFillSchemeClr','SpPrSolidFillSchemeClrTransformations','OriginalSolidFillClr'),'lineColor':('SpPrLnSolidFillSchemeClr','SpPrLnSolidFillResolvedSchemeClr','SpPrLnSolidFillSchemeClrTransformations','OriginalLnSolidFillClr')}

def style_interface(value,name):
    try:return value.queryInterface(uno.getTypeByName(name))
    except:return None

def style_targets(session,view,kind):
    selected=view['controller'].getSelection();format=session['format'];values=[]
    if kind=='cells':
        if format!='xlsx':fail('NATIVE_STYLE_TARGET_UNAVAILABLE','请在工作表中选择真实单元格范围。')
        if hasattr(selected,'getRangeAddresses'):
            addresses=selected.getRangeAddresses()
            if len(addresses)>64:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','所选范围数量过多。')
            for address in addresses:
                if (address.EndColumn-address.StartColumn+1)*(address.EndRow-address.StartRow+1)>10000:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','单次样式范围最多包含一万个单元格。')
                sheet=session['doc'].getSheets().getByIndex(address.Sheet)
                values.append(sheet.getCellRangeByPosition(address.StartColumn,address.StartRow,address.EndColumn,address.EndRow))
        elif style_interface(selected,'com.sun.star.sheet.XSheetCellRange') is not None:
            address=selected.getRangeAddress()
            if (address.EndColumn-address.StartColumn+1)*(address.EndRow-address.StartRow+1)>10000:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','单次样式范围最多包含一万个单元格。')
            values=[selected]
    elif kind=='shape':
        if style_interface(selected,'com.sun.star.drawing.XShapes') is not None:
            if selected.getCount()>64:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','所选对象数量过多。')
            values=[selected.getByIndex(index) for index in range(selected.getCount())]
        elif style_interface(selected,'com.sun.star.drawing.XShape') is not None:values=[selected]
        if any(style_interface(value,'com.sun.star.drawing.XShape') is None for value in values):values=[]
    elif kind in ['text','paragraph']:
        # Text shapes also implement XTextRange for their entire content. A shape
        # selection is not proof that its text was selected in the native editor.
        if style_interface(selected,'com.sun.star.drawing.XShapes') is not None or style_interface(selected,'com.sun.star.drawing.XShape') is not None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','请进入对象文字编辑并选择真实文字范围。')
        if format=='docx' and hasattr(selected,'getCount'):
            if selected.getCount()>64:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','所选文字范围数量过多。')
            values=[selected.getByIndex(index) for index in range(selected.getCount())]
        elif style_interface(selected,'com.sun.star.text.XTextRange') is not None:values=[selected]
        if kind=='text':values=[value for value in values if style_interface(value,'com.sun.star.text.XTextRange') is not None and value.getString()]
        elif format=='docx' and not values:values=[view['controller'].getViewCursor()]
        if kind=='paragraph':
            cursors=[]
            for value in values:
                if style_interface(value,'com.sun.star.text.XTextRange') is None:continue
                cursor=value.Text.createTextCursorByRange(value.getStart())
                if value.getString():cursor.gotoRange(value.getEnd(),True)
                else:
                    if style_interface(cursor,'com.sun.star.text.XParagraphCursor') is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生文字位置不提供段落范围。')
                    cursor.gotoStartOfParagraph(False);cursor.gotoEndOfParagraph(True)
                cursors.append(cursor)
            values=cursors
    if not values:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','没有可操作的真实原生选区或对象。')
    return values

def style_state_name(value):
    value=getattr(value,'value',value)
    return {'DIRECT_VALUE':'direct','DEFAULT_VALUE':'default','AMBIGUOUS_VALUE':'mixed',0:'direct',1:'default',2:'mixed'}.get(value,'direct')

def style_property_names(kind,field):
    if field in STYLE_SCRIPT_PROPERTIES:return STYLE_SCRIPT_PROPERTIES[field]
    if field=='alignment':return ('HoriJustify' if kind=='cells' else 'ParaAdjust',)
    if field=='fill':return ('CellBackColor' if kind=='cells' else 'FillColor',)
    return (STYLE_PROPERTIES[field],) if field in STYLE_PROPERTIES else ()

def style_binding(value,kind,fields):
    try:info={p.Name:p for p in value.getPropertySetInfo().getProperties()}
    except:info={}
    names=list(dict.fromkeys(name for field in fields for name in style_property_names(kind,field) if name in info))
    for color in tuple(names):
        for dependency in STYLE_COLOR_DEPENDENCIES.get(color,()):
            if dependency in info and dependency not in names:names.append(dependency)
    if kind=='shape' and any(field in STYLE_COLOR_GRAB_KEYS for field in fields) and 'InteropGrabBag' in info:names.append('InteropGrabBag')
    for extra in ['CharBackTransparent','CellBackTransparent','FillStyle','LineStyle','MoveProtect','SizeProtect']:
        if extra in info and extra not in names:names.append(extra)
    if kind!='cells' and 'alignment' in fields and 'WritingMode' in info and 'WritingMode' not in names:names.append('WritingMode')
    raw={};states={}
    try:raw=dict(zip(names,value.getPropertyValues(tuple(names))))
    except:
        for name in names:
            try:raw[name]=value.getPropertyValue(name)
            except:pass
    try:states=dict(zip(names,(style_state_name(v) for v in value.getPropertyStates(tuple(names)))))
    except:
        for name in names:
            try:states[name]=style_state_name(value.getPropertyState(name))
            except:states[name]='direct'
    geometry={}
    if kind=='shape':
        try:geometry={'position':value.getPosition(),'size':value.getSize()}
        except:pass
    return {'target':value,'info':info,'raw':raw,'states':states,'geometry':geometry}

def style_decode(session,kind,field,value,binding=None):
    enum=getattr(value,'value',value)
    if field=='bold':return float(value)>=150.
    if field=='italic':return enum not in ['NONE',0]
    if field in ['underline','strike']:return int(value)!=0
    if field in ['color','highlight','fill','lineColor']:return ('%06x'%int(value)) if 0<=int(value)<=0xffffff else None
    if field in ['left','right','firstLine','top','bottom']:return float(value)/100.
    if field=='rotation':return float(value)/100.
    if field=='lineWidth':return float(value)*72/2540
    if field=='lineSpacingPercent':return float(value.Height) if int(value.Mode)==constant('com.sun.star.style.LineSpacingMode.PROP',0) else None
    if field=='numberFormat':return str(session['doc'].NumberFormats.getByKey(int(value)).getPropertyValue('FormatString'))
    if field=='alignment':
        if kind=='cells':return {'LEFT':'left','CENTER':'center','RIGHT':'right','BLOCK':'justify',1:'left',2:'center',3:'right',4:'justify'}.get(enum)
        if enum in ['START','END',5,6]:
            # LO 26.2+ retains OOXML logical alignment. The actual property
            # supplies effective LTR/RTL; contextual/vertical/unknown modes are
            # not proof of a physical horizontal alignment.
            writing=(binding or {}).get('raw',{}).get('WritingMode');writing=getattr(writing,'value',writing)
            direction=None if isinstance(writing,bool) else {0:'left',1:'right','LR_TB':'left','RL_TB':'right'}.get(writing)
            if direction is None:return None
            return direction if enum in ['START',5] else 'right' if direction=='left' else 'left'
        return {'LEFT':'left','RIGHT':'right','BLOCK':'justify','CENTER':'center',0:'left',1:'right',2:'justify',3:'center'}.get(enum)
    if field=='verticalAlignment':return {'TOP':'top','CENTER':'center','BOTTOM':'bottom',1:'top',2:'center',3:'bottom'}.get(enum)
    if isinstance(value,(str,int,float,bool)) or value is None:return value
    raise ValueError('non-scalar native property')

def style_field_samples(session,binding,kind,field):
    raw=binding['raw'];info=binding['info'];states=binding['states'];geometry=binding['geometry']
    if field in ['x','y','width','height']:
        key='position' if field in ['x','y'] else 'size';attribute={'x':'X','y':'Y','width':'Width','height':'Height'}[field]
        protect='MoveProtect' if key=='position' else 'SizeProtect'
        if key not in geometry or raw.get(protect) is True:raise ValueError('对象几何不可用或受到保护。')
        return [(float(getattr(geometry[key],attribute))/100.,'direct')]
    names=[name for name in style_property_names(kind,field) if name in info]
    if not names or any(name not in raw or info[name].Attributes&16 for name in names):raise ValueError('所选目标不支持此属性或属性为只读。')
    result=[]
    for name in names:
        state=states.get(name,'direct')
        if session['format']=='pptx' and state=='mixed':raise ValueError('此对象内部混合样式没有可验证的原生逐段恢复目标。')
        if field=='alignment' and kind!='cells' and getattr(raw[name],'value',raw[name]) in ['START','END',5,6] and states.get('WritingMode')=='mixed':state='mixed'
        value=None if state=='mixed' else style_decode(session,kind,field,raw[name],binding)
        result.append((value,state))
    return result

def inspect_native_style(session,view,kind):
    if kind not in STYLE_FIELDS:fail('INVALID_NATIVE_STYLE','样式目标类型无效。')
    fields={}
    try:targets=style_targets(session,view,kind);bindings=[style_binding(value,kind,STYLE_FIELDS[kind]) for value in targets]
    except Exception as error:
        reason=str(error).split('|')[-1]
        return {'targetKind':kind,'fields':{field:{'value':None,'state':'unsupported','available':False,'reason':reason} for field in STYLE_FIELDS[kind]}}
    for field in STYLE_FIELDS[kind]:
        try:
            samples=[item for binding in bindings for item in style_field_samples(session,binding,kind,field)]
            values=[value for value,state in samples];mixed=any(state=='mixed' for value,state in samples) or any(value!=values[0] for value in values[1:])
            fields[field]={'value':None if mixed else values[0],'state':'mixed' if mixed else 'default' if all(state=='default' for value,state in samples) else 'direct','available':True}
            if not mixed and values[0] is None:fields[field]['reason']='当前原生逻辑对齐或书写方向无法确认物理左右对齐。' if field=='alignment' else '当前为原生自动值或非此输入模式。'
        except:fields[field]={'value':None,'state':'unsupported','available':False,'reason':'所选目标不支持此属性或属性为只读。'}
    return {'targetKind':kind,'fields':fields}

def style_typed_value(descriptor,value,enum_name=None):
    name=descriptor.Type.typeName
    if name in ['short','long','hyper','float','double','boolean','string']:return uno.Any(name,value)
    if enum_name is not None:return uno.Enum(name,enum_name)
    return value

def style_validate_value(field,value):
    if field in ['bold','italic','underline','strike','wrap']:
        if type(value) is not bool:fail('INVALID_NATIVE_STYLE','样式开关必须是布尔值。')
    elif field in ['color','highlight','fill','lineColor']:
        if not isinstance(value,str) or not re.fullmatch(r'[0-9a-fA-F]{6}',value):fail('INVALID_NATIVE_STYLE','样式颜色必须是六位十六进制值。')
    elif field in ['fontFamily','numberFormat']:
        if not isinstance(value,str) or not value.strip() or len(value)>1000:fail('INVALID_NATIVE_STYLE','样式文本无效。')
    elif field in ['alignment','verticalAlignment']:
        if value not in (['left','center','right','justify'] if field=='alignment' else ['top','center','bottom']):fail('INVALID_NATIVE_STYLE','对齐值无效。')
    elif not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or abs(value)>100000 or field in ['fontSize','width','height','lineSpacingPercent'] and value<=0 or field=='lineWidth' and value<0:fail('INVALID_NATIVE_STYLE','样式数值无效。')

def prepare_native_style(session,view,patch,actual_targets=None):
    kind=patch.get('target');values=patch.get('values')
    if kind not in STYLE_FIELDS or not isinstance(values,dict) or not values or any(field not in STYLE_FIELDS[kind] for field in values):fail('INVALID_NATIVE_STYLE','样式字段与目标类型不匹配。')
    for field,value in values.items():style_validate_value(field,value)
    bindings=[style_binding(value,kind,values) for value in (style_targets(session,view,kind) if actual_targets is None else actual_targets)]
    for binding in bindings:
        if 'InteropGrabBag' in binding['info'] and kind=='shape' and any(field in STYLE_COLOR_GRAB_KEYS for field in values):
            if 'InteropGrabBag' not in binding['raw'] or not isinstance(binding['raw']['InteropGrabBag'],(tuple,list)) or binding['info']['InteropGrabBag'].Type.typeName!='[]com.sun.star.beans.PropertyValue' or binding['info']['InteropGrabBag'].Attributes&16 or binding['states'].get('InteropGrabBag')=='mixed':fail('NATIVE_STYLE_FIELD_UNSUPPORTED','颜色互操作依赖没有可验证的可写恢复值。')
        for field in values:
            try:style_field_samples(session,binding,kind,field)
            except:fail('NATIVE_STYLE_FIELD_UNSUPPORTED','至少一个真实目标不支持所请求的样式字段。')
            for color in style_property_names(kind,field):
                for dependency in STYLE_COLOR_DEPENDENCIES.get(color,()):
                    if dependency not in binding['info']:continue
                    if dependency not in binding['raw'] or dependency not in binding['states'] or binding['info'][dependency].Attributes&16 or binding['states'][dependency]=='mixed':fail('NATIVE_STYLE_FIELD_UNSUPPORTED','颜色主题依赖没有可验证的可写恢复值。')
                    if dependency in STYLE_COMPLEX_COLORS and binding['info'][dependency].Type.typeName!='com.sun.star.util.XComplexColor':fail('NATIVE_STYLE_FIELD_UNSUPPORTED','颜色主题接口类型不可用。')
            if session['format']=='pptx' and any(binding['states'].get(name)=='mixed' for name in style_property_names(kind,field)):fail('NATIVE_STYLE_FIELD_UNSUPPORTED','此混合对象样式没有可验证的原生逐段恢复目标。')
    return kind,values,bindings

def native_style_updates(session,binding,kind,values,created_formats):
    updates={};info=binding['info']
    def put(name,value,enum_name=None):
        if name not in info or info[name].Attributes&16:fail('NATIVE_STYLE_FIELD_UNSUPPORTED','原生样式属性不可写。')
        updates[name]=style_typed_value(info[name],value,enum_name)
    for field,value in values.items():
        if field in ['x','y','width','height']:continue
        names=[name for name in style_property_names(kind,field) if name in info]
        for name in names:
            if field in ['color','highlight','fill','lineColor']:put(name,int(value,16))
            elif field=='bold':put(name,150. if value else 100.)
            elif field=='italic':put(name,2 if value else 0,'ITALIC' if value else 'NONE')
            elif field in ['underline','strike']:put(name,1 if value else 0)
            elif field in ['left','right','firstLine','top','bottom']:put(name,round(value*100))
            elif field=='rotation':put(name,round(value*100))
            elif field=='lineWidth':put(name,round(value*2540/72))
            elif field=='lineSpacingPercent':
                spacing=uno.createUnoStruct('com.sun.star.style.LineSpacing');spacing.Mode=constant('com.sun.star.style.LineSpacingMode.PROP',0);spacing.Height=round(value);put(name,spacing)
            elif field=='alignment':
                numbers={'left':1,'center':2,'right':3,'justify':4} if kind=='cells' else {'left':0,'center':3,'right':1,'justify':2}
                put(name,numbers[value],{'left':'LEFT','center':'CENTER','right':'RIGHT','justify':'BLOCK'}[value])
            elif field=='verticalAlignment':put(name,{'top':1,'center':2,'bottom':3}[value],value.upper())
            elif field=='numberFormat':
                formats=session['doc'].NumberFormats;locale=binding['target'].getPropertyValue('CharLocale');key=formats.queryKey(value,locale,True)
                if key<0:key=formats.addNew(value,locale);created_formats.append(key)
                put(name,key)
            else:put(name,value)
        if field=='highlight' and 'CharBackTransparent' in info:put('CharBackTransparent',False)
        if field=='fill':
            if kind=='cells' and 'CellBackTransparent' in info:put('CellBackTransparent',False)
            elif kind=='shape' and 'FillStyle' in info:put('FillStyle',1,'SOLID')
        if field in ['lineColor','lineWidth'] and 'LineStyle' in info:put('LineStyle',1,'SOLID')
        if field in ['fill','lineColor'] and kind=='shape':
            complex_name='FillComplexColor' if field=='fill' else 'LineComplexColor'
            if complex_name in info:put(complex_name,uno.Any('com.sun.star.util.XComplexColor',None))
            # Unused complex colors are omitted by ODF serialization and may
            # inherit a parent's theme in the read-only snapshot clone. Keep
            # an explicit non-themed native override after clearing transforms.
            if field=='fill' and 'FillColorTheme' in info:put('FillColorTheme',-1)
        if field=='color' and 'CharColorTheme' in info:put('CharColorTheme',-1)
    if kind=='shape' and 'InteropGrabBag' in binding['raw']:
        removed={key for field in values for key in STYLE_COLOR_GRAB_KEYS.get(field,())};bag=binding['raw']['InteropGrabBag']
        filtered=tuple(item for item in bag if item.Name not in removed)
        if len(filtered)!=len(bag):put('InteropGrabBag',uno.Any('[]com.sun.star.beans.PropertyValue',filtered))
    return updates

def style_value_key(value):
    if isinstance(value,(str,int,float,bool)) or value is None:return value
    if all(hasattr(value,name) for name in ['getType','getThemeColorType','resolveColor']):return ('complex-color',value.getType(),value.getThemeColorType(),value.resolveColor(None))
    if isinstance(value,(tuple,list)):return tuple(style_value_key(item) for item in value)
    if hasattr(value,'Name') and hasattr(value,'Value'):return ('property-value',value.Name,style_value_key(getattr(value,'State',None)),style_value_key(value.Value))
    for names in [('X','Y'),('Width','Height'),('Mode','Height')]:
        if all(hasattr(value,name) for name in names):return tuple((name,getattr(value,name)) for name in names)
    if hasattr(value,'value'):return ('enum',getattr(value,'typeName',''),value.value)
    return str(value)

def restore_native_style(binding):
    target=binding['target']
    for name,value in binding['raw'].items():
        if name in STYLE_COMPLEX_COLORS:continue
        # Theme/Lum/Tint and RGB share the same native color item. The RGB
        # default restores that entire item; repeating dependency defaults
        # after a direct RGB restoration could clear that RGB again.
        if any(name in dependencies and (binding['states'].get(color)=='default' or any(complex_name in binding['raw'] and STYLE_COMPLEX_COLORS[complex_name]==color for complex_name in STYLE_COMPLEX_COLORS)) for color,dependencies in STYLE_COLOR_DEPENDENCIES.items()):continue
        if binding['info'][name].Attributes&16:continue
        if binding['states'].get(name)=='mixed':fail('NATIVE_STYLE_ROLLBACK_FAILED','混合样式未产生可回滚的原生撤销记录。')
        if binding['states'].get(name)=='default':target.setPropertyToDefault(name)
        else:target.setPropertyValue(name,uno.Any('[]com.sun.star.beans.PropertyValue',value) if name=='InteropGrabBag' else value)
    for name,value in binding['raw'].items():
        if name not in STYLE_COMPLEX_COLORS or binding['states'].get(STYLE_COMPLEX_COLORS[name])=='default':continue
        # UnoComplexColor is an immutable native value carrier. Restoring the
        # captured interface copies all hidden transformations as well as the
        # publicly inspectable type/theme/final color, without clearing RGB.
        target.setPropertyValue(name,uno.Any('com.sun.star.util.XComplexColor',value))
    if 'position' in binding['geometry'] and style_value_key(target.getPosition())!=style_value_key(binding['geometry']['position']):target.setPosition(binding['geometry']['position'])
    if 'size' in binding['geometry'] and style_value_key(target.getSize())!=style_value_key(binding['geometry']['size']):target.setSize(binding['geometry']['size'])

def verify_native_style_restore(binding):
    target=binding['target']
    for name,value in binding['raw'].items():
        if binding['states'].get(name)=='mixed':
            if style_state_name(target.getPropertyState(name))!='mixed':return False
        elif style_value_key(target.getPropertyValue(name))!=style_value_key(value):return False
    for key,method in [('position','getPosition'),('size','getSize')]:
        if key in binding['geometry'] and style_value_key(getattr(target,method)())!=style_value_key(binding['geometry'][key]):return False
    return True

class NativeStyleUndo(unohelper.Base,XUndoAction):
    def __init__(self,label,before,after,document=None):self.label=label;self.Title=label;self.before=before;self.after=after;self.document=document
    def getTitle(self):return self.label
    def restore(self,bindings):
        changed=not all(verify_native_style_restore(binding) for binding in bindings)
        for binding in bindings:restore_native_style(binding)
        if not all(verify_native_style_restore(binding) for binding in bindings):fail('NATIVE_STYLE_ROLLBACK_FAILED','原生对象样式撤销或重做未完整恢复。')
        if changed and self.document is not None:self.document.setModified(True)
    def undo(self):self.restore(self.before)
    def redo(self):self.restore(self.after)

def apply_native_style(session,view,patch,args):
    if not isinstance(args.get('expectedSelectionEpoch'),int) or isinstance(args['expectedSelectionEpoch'],bool) or args['expectedSelectionEpoch']<0:fail('INVALID_NATIVE_STYLE','原生样式必须绑定明确的选区版本。')
    kind,values,bindings=prepare_native_style(session,view,patch);expected(session,view,args)
    text_target=None
    if session['format']=='pptx' and kind in ['text','paragraph']:
        value=selected_text_range(session,view)
        if value is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字范围不能作为实际编辑目标。')
        text_target=ppt_text_transaction_target(session,view,value)
    manager=session['doc'].getUndoManager();windows=[];context_open=False;writes_started=False;created_formats=[];label='AgentViewer 样式 '+str(uuid.uuid4())
    before_titles=list(manager.getAllUndoActionTitles());before_redo=list(manager.getAllRedoActionTitles())
    try:
        for candidate in session['views'].values():
            if candidate.get('disposed'):continue
            cached=candidate.get('accessibilityCache',{}).get('data')
            if own_ime_pending(candidate) or cached and cached[2]:fail('NATIVE_PENDING_INPUT','原生输入尚未完成，没有隐式提交。')
            window=candidate['frame'].getContainerWindow()
            if not window.isEnabled():fail('NATIVE_PENDING_INPUT','原生对话框尚未结束。')
            windows.append(window);window.setEnable(False)
        expected(session,view,args)
        if text_target is not None:
            model=ppt_text_model_range(session,view,text_target,args)
            kind,values,bindings=prepare_native_style(session,view,patch,[model])
        if manager.isLocked():fail('NATIVE_UNDO_BUSY','原生撤销事务尚未结束。')
        manager.enterUndoContext(label);context_open=True
        # Build all typed values (including new number format validation) before
        # touching any selected object's properties.
        prepared=[native_style_updates(session,binding,kind,values,created_formats) for binding in bindings]
        for binding,updates in zip(bindings,prepared):
            target=binding['target']
            writes_started=True
            for name,value in updates.items():target.setPropertyValue(name,value)
            if kind=='shape':
                if 'x' in values or 'y' in values:
                    position=uno.createUnoStruct('com.sun.star.awt.Point');old=binding['geometry']['position'];position.X=round(values['x']*100) if 'x' in values else old.X;position.Y=round(values['y']*100) if 'y' in values else old.Y;target.setPosition(position)
                if 'width' in values or 'height' in values:
                    size=uno.createUnoStruct('com.sun.star.awt.Size');old=binding['geometry']['size'];size.Width=round(values['width']*100) if 'width' in values else old.Width;size.Height=round(values['height']*100) if 'height' in values else old.Height;target.setSize(size)
        if text_target is not None and not all(verify_native_style_restore(binding) for binding in bindings):session['doc'].setModified(True)
        try:manager.leaveUndoContext()
        finally:context_open=False
        # Impress direct XShape setters emit model modifications but do not add
        # undo actions. Preserve exact before/after values in one real UNO action.
        if writes_started and list(manager.getAllUndoActionTitles())==before_titles and not all(verify_native_style_restore(binding) for binding in bindings):
            after_bindings=[style_binding(binding['target'],kind,values) for binding in bindings]
            action=NativeStyleUndo(label,bindings,after_bindings,session['doc'] if text_target is not None else None);manager.addUndoAction(action)
    except Exception as error:
        if context_open:
            try:manager.leaveUndoContext()
            finally:context_open=False
        changed=writes_started and not all(verify_native_style_restore(binding) for binding in bindings)
        if changed:
            try:
                after=list(manager.getAllUndoActionTitles())
                if after==[label]+before_titles:
                    manager.undo()
                    if not before_redo and list(manager.getAllRedoActionTitles())==[label]:manager.clearRedo() # Own failed action only; never old history.
                if not all(verify_native_style_restore(binding) for binding in bindings):
                    for binding in bindings:restore_native_style(binding)
                if not all(verify_native_style_restore(binding) for binding in bindings):fail('NATIVE_STYLE_ROLLBACK_FAILED','原生样式未完整回滚，保留当前模型供恢复。')
            except:fail('NATIVE_STYLE_ROLLBACK_FAILED','原生样式未完整回滚，保留当前模型供恢复。')
        for key in created_formats:
            try:session['doc'].NumberFormats.removeByKey(key)
            except:fail('NATIVE_STYLE_ROLLBACK_FAILED','临时数字格式未完整回滚。')
        if writes_started and list(manager.getAllRedoActionTitles())!=before_redo:fail('NATIVE_STYLE_ROLLBACK_UNVERIFIED','属性已恢复，但原生重做历史发生改变；已保留当前模型供恢复。')
        if isinstance(error,RuntimeError) and '|' in str(error):raise
        fail('NATIVE_STYLE_APPLY_FAILED','原生样式写入失败，已撤回本次属性修改。')
    finally:
        failed=False
        for window in reversed(windows):
            try:window.setEnable(True)
            except:failed=True
        if failed:fail('NATIVE_INPUT_RESTORE_FAILED','原生视图输入未恢复，请保留文档并重新打开该视图。')
`;
