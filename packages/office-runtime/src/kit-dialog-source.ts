/** Native UNO UITest controls. Community LibreOfficeKit has no JSDialog ABI. */
export const officeKitDialogSource = String.raw`
def native_dialog_root(view,window):
    if window['kind']!='dialog':return None
    handle=kit_window_handle(window['id'])
    if not handle:fail('STALE_OFFICE_WINDOW','Office 原生窗口已销毁。')
    toolkit=sm.createInstanceWithContext('com.sun.star.awt.Toolkit',ctx);matches=[]
    for index in range(toolkit.getTopWindowCount()):
        peer=toolkit.getTopWindow(index)
        try:actual=int(peer.getWindowHandle((),1))
        except:continue
        if actual==handle:matches.append(peer)
    if len(matches)!=1:fail('OFFICE_WINDOW_CONTROLS_UNAVAILABLE','Office 未提供唯一的原生窗口控件目标。')
    service=sm.createInstanceWithContext('com.sun.star.ui.test.UITest',ctx)
    if service is None:fail('OFFICE_WINDOW_CONTROLS_UNAVAILABLE','Office 没有提供原生控件接口。')
    root=service.getWindow(matches[0]);bindings=view.setdefault('dialogBindings',{});previous=bindings.get(window['id'])
    if previous and (previous['instanceId']!=window['instanceId'] or previous['handle']!=handle or not previous['root'].equals(root)):
        fail('STALE_OFFICE_WINDOW','Office 原生控件窗口已经替换。')
    return root,handle,matches[0]

def dialog_native_state(control):return {item.Name:str(item.Value) for item in control.getState()}

def dialog_pair(value):
    values=str(value or '').split('x')
    try:return tuple(int(item) for item in values) if len(values)==2 else (0,0)
    except:return (0,0)

def dialog_accessibility(peer):
    # VCLXWindow's XAccessible property returns the actual native accessibility
    # object. Widget IDs come from XAccessibleContext2, never from captions.
    result={};seen=[0];list_role=constant('com.sun.star.accessibility.AccessibleRole.LIST',-1)
    def visit(context,depth):
        seen[0]+=1
        if seen[0]>4096 or depth>32:return
        try:identifier=context.getAccessibleId()
        except:identifier=''
        if identifier:result.setdefault(str(identifier),[]).append(context)
        try:
            # Individual list entries are read in native index order on demand.
            if context.getAccessibleRole()==list_role:return
            count=int(context.getAccessibleChildCount())
            for index in range(min(count,1024)):
                child=context.getAccessibleChild(index)
                if child is not None:visit(child.getAccessibleContext(),depth+1)
        except:return
    try:visit(peer.getProperty('XAccessible').getAccessibleContext(),0)
    except:pass
    return result

def dialog_accessible_caption(context):
    try:
        relations=context.getAccessibleRelationSet();label_type=constant('com.sun.star.accessibility.AccessibleRelationType.LABELED_BY',-1)
        for index in range(relations.getRelationCount()):
            relation=relations.getRelation(index)
            if relation.RelationType==label_type:
                names=[target.getAccessibleContext().getAccessibleName() for target in relation.TargetSet]
                label=' '.join(name for name in names if name)
                if label:return label
        return context.getAccessibleName()
    except:return ''

def dialog_native_options(context,control_type,native_state,identifier):
    vertical=control_type=='VerticalTabControlUIObject'
    wanted=constant('com.sun.star.accessibility.AccessibleRole.PAGE_TAB_LIST' if control_type=='TabControlUIObject' else 'com.sun.star.accessibility.AccessibleRole.LIST',-1)
    candidates=[]
    def find(value,depth):
        if depth>3:return
        if value.getAccessibleRole()==wanted:candidates.append(value);return
        for index in range(min(int(value.getAccessibleChildCount()),16)):
            child=value.getAccessibleChild(index)
            if child is not None:find(child.getAccessibleContext(),depth+1)
    try:
        if vertical:
            # The exact VerticalTabControl's direct LIST child is its real
            # SvtIconChoiceCtrl chooser; other lists belong to page contents.
            for index in range(min(int(context.getAccessibleChildCount()),16)):
                child=context.getAccessibleChild(index).getAccessibleContext()
                if child.getAccessibleRole()==wanted:candidates.append(child)
        else:find(context,0)
        if len(candidates)!=1:return None
        source=candidates[0];count=int(source.getAccessibleChildCount());expected=int(native_state.get('PageCount' if control_type in ['TabControlUIObject','VerticalTabControlUIObject'] else 'EntryCount','-1'))
        if count!=expected or not 0<=count<=2048:return None
        selected=constant('com.sun.star.accessibility.AccessibleStateType.SELECTED',-1);options=[]
        for index in range(count):
            child=source.getAccessibleChild(index).getAccessibleContext();caption=str(child.getAccessibleName())
            token=hashlib.sha256((identifier+':'+str(index)+':'+caption).encode()).hexdigest()[:32]
            # This pinned UNO API returns a hyper bitmask, not the removed
            # XAccessibleStateSet object used by older engine releases.
            options.append({'id':token,'text':caption,'selected':bool(int(child.getAccessibleStateSet())&selected)})
        current=native_state.get('CurrPagePos' if control_type in ['TabControlUIObject','VerticalTabControlUIObject'] else 'SelectEntryPos')
        if current is not None:
            position=int(current)
            for index,option in enumerate(options):option['selected']=index==position
        return options,source
    except:return None

def dialog_kind(implementation,control_type):
    if control_type=='CheckBoxUIObject':return 'checkbox'
    if control_type=='RadioButtonUIObject':return 'radio'
    if control_type=='ButtonUIObject':return 'button'
    if control_type in ['FormattedFieldUIObject','MetricFieldUIObject','SpinFieldUIObject']:return 'number'
    if control_type in ['EditUIObject','MultiLineEditUIObject']:return 'text'
    if control_type in ['ListBoxUIObject','ComboBoxUIObject']:return 'select'
    if control_type in ['TabControlUIObject','VerticalTabControlUIObject']:return 'tabs'
    if implementation=='class FixedText':return 'label'
    if implementation in ['class Dialog','class VclVBox','class VclHBox','class VclBox','class VclGrid','class VclFrame','class VclContainer','class VclHButtonBox','class VclVButtonBox','class ImplBorderWindow']:return 'container'
    return 'unknown'

def dialog_unbound_interactive(value):
    # A failed UITest lookup must not make an editable native widget disappear
    # from the capability report. Use native widget evidence, never captions or
    # generic focus/visibility flags shared by layout and decorative windows.
    implementation=str(value.get('ImplementationName',''))
    if implementation in ['class Edit','class VclMultiLineEdit','class MultiLineEdit','class PushButton','class OKButton','class CancelButton','class HelpButton','class CheckBox','class TriStateBox','class RadioButton','class SpinField','class NumericField','class MetricField','class FormattedField','class CurrencyField','class DateField','class TimeField','class PatternField','class ListBox','class ComboBox','class TabControl','class VerticalTabControl','class ToolBox']:
        return True
    return any(key in value for key in ['MaxTextLength','EntryCount','SelectEntryPos','SelectEntryText','SelectionCount','PageCount','CurrPagePos','ItemCount'])

def dialog_multiline_editor(context):
    if context is None:return None
    try:return context.queryInterface(uno.getTypeByName('com.sun.star.accessibility.XAccessibleEditableText'))
    except:return None

def read_native_dialog(view,window):
    found=native_dialog_root(view,window)
    if found is None:return None
    root,handle,peer=found;text=root.getHierarchy()
    if len(text)>2*1024*1024:fail('OFFICE_WINDOW_CONTROL_LIMIT','Office 对话框控件结构过大。')
    try:raw=json.loads(text)
    except:fail('OFFICE_WINDOW_CONTROLS_UNAVAILABLE','Office 返回的原生控件结构不可解析。')
    targets={};labels=[];fields=[];unsupported=[];count=[0];namespace=uuid.UUID(window['instanceId']);root_position=dialog_pair(raw.get('AbsPosition'));accessibility=dialog_accessibility(peer)
    def visit(value,path,parent_position=(0,0),parent_visible=True,parent_enabled=True,input_owner=False):
        count[0]+=1
        if count[0]>1024 or len(path)>128 or not isinstance(value,dict):fail('OFFICE_WINDOW_CONTROL_LIMIT','Office 对话框控件数量或深度超出范围。')
        native_id=str(value.get('ID',''));native=None;control_type='';native_state=value;position=dialog_pair(value.get('RelPosition'));size=dialog_pair(value.get('Size'))
        absolute=dialog_pair(value.get('AbsPosition'));location=(absolute[0]-root_position[0],absolute[1]-root_position[1])
        if native_id:
            try:
                candidate=root if path=='0' else root.getChild(native_id);actual=dialog_native_state(candidate)
                # getChild can search the whole top-level tree. Reject ambiguous
                # duplicate IDs rather than allowing a different native widget.
                if all(actual.get(key)==str(value.get(key,'')) for key in ['ID','WindowType','AbsPosition','Size']):native=candidate;native_state=actual;control_type=candidate.getType()
            except:pass
        kind=dialog_kind(str(value.get('ImplementationName','')),control_type);identifier=uuid.uuid5(namespace,path+':'+native_id).hex
        # Spinners and editable ComboBoxes expose an anonymous inner Edit in
        # their VCL tree. The safely bound semantic input already supplies its
        # value/action; do not render or report that implementation widget twice.
        # Named controls, independent inputs under containers/tabs and failed
        # named bindings remain separate targets and are never covered this way.
        covered_edit=input_owner and not native_id and value.get('ImplementationName')=='class Edit'
        visible=parent_visible and value.get('Visible')=='true' and not covered_edit;enabled=parent_enabled and value.get('Enabled')=='true'
        node={'id':identifier,'kind':kind,'enabled':enabled,'visible':visible,'actions':[]}
        if control_type=='MultiLineEditUIObject':node['multiline']=True
        if native_id:node['nativeId']=native_id
        caption=str(native_state.get('DisplayText') or native_state.get('Text',''))
        if kind in ['text','number','select','tabs']:
            node['value']=str(native_state.get('Text',native_state.get('Value','')));fields.append((node,location,size))
        elif caption:node['text']=caption
        if kind in ['checkbox','radio']:node['checked']=native_state.get('Selected')=='true'
        contexts=accessibility.get(native_id,[]) if native_id else []
        role_name='COMBO_BOX' if control_type=='ComboBoxUIObject' else 'LIST' if control_type=='ListBoxUIObject' else 'PAGE_TAB_LIST' if control_type=='TabControlUIObject' else None
        if role_name:
            role=constant('com.sun.star.accessibility.AccessibleRole.'+role_name,-1)
            contexts=[context for context in contexts if context.getAccessibleRole()==role]
        accessible=contexts[0] if len(contexts)==1 else None
        if accessible is not None:
            label=dialog_accessible_caption(accessible)
            if label and kind in ['text','number','select','tabs'] and label!=node.get('value'):node['text']=label
        if native is not None:
            allowed={'button':['click'],'checkbox':['toggle'],'radio':['click'],'text':['set-text'],'number':['set-text']}.get(kind,[])
            text_editor=dialog_multiline_editor(accessible) if control_type=='MultiLineEditUIObject' else None
            if control_type=='MultiLineEditUIObject' and text_editor is None:allowed=[]
            native_options=dialog_native_options(accessible,control_type,native_state,identifier) if accessible is not None and kind in ['select','tabs'] else None
            options,option_source=native_options if native_options is not None else (None,None)
            if options is not None:
                node['options']=options;allowed=['select']
                if control_type=='ComboBoxUIObject':allowed.append('set-text')
            if visible and enabled and native_state.get('ReadOnly')!='true':node['actions']=allowed
            targets[identifier]={'object':native,'nativeId':native_id,'type':control_type,'state':native_state,'actions':node['actions'],'options':{option['id']:index for index,option in enumerate(options)} if options is not None else {},'selection':option_source if control_type=='VerticalTabControlUIObject' else None,'textEditor':text_editor}
            if visible and kind in ['select','tabs'] and options is None:unsupported.append({'nodeId':identifier,'nativeType':control_type,'reason':'NATIVE_OPTIONS_NOT_ENUMERABLE'})
            elif visible and kind=='unknown' and native_id and not value.get('children'):unsupported.append({'nodeId':identifier,'nativeType':control_type,'reason':'NATIVE_CONTROL_NOT_ADAPTED'})
            elif visible and control_type=='MultiLineEditUIObject' and text_editor is None and native_state.get('ReadOnly')!='true':unsupported.append({'nodeId':identifier,'nativeType':control_type,'reason':'NATIVE_TEXT_EDITOR_UNAVAILABLE'})
        elif visible and dialog_unbound_interactive(value):
            unsupported.append({'nodeId':identifier,'nativeType':str(value.get('ImplementationName','')),'reason':'NATIVE_CONTROL_NOT_BOUND'})
        if kind=='label' and visible:labels.append((node,location,size))
        children=value.get('children',[])
        if not isinstance(children,list):fail('OFFICE_WINDOW_CONTROLS_UNAVAILABLE','Office 原生控件子节点无效。')
        child_input_owner=(native is not None and (kind in ['text','number'] or control_type=='ComboBoxUIObject')) or (input_owner and kind=='container')
        if children:node['children']=[visit(child,path+'.'+str(index),location,visible,enabled,child_input_owner) for index,child in enumerate(children)]
        return node
    tree=visit(raw,'0')
    # Preserve actual native labels. For edits/spinners, associate the nearest
    # real label to the left on the same row, including border-window wrappers.
    for node,position,size in fields:
        candidates=[(position[0]-(point[0]+dimensions[0]),label) for label,point,dimensions in labels if label.get('text') and point[0]+dimensions[0]<=position[0]+2 and (abs(point[1]-position[1]) if node.get('multiline') else abs(point[1]+dimensions[1]/2-position[1]-size[1]/2))<=max(5,min(size[1],dimensions[1])/2)]
        if candidates:
            label=min(candidates,key=lambda item:item[0])[1];node.setdefault('text',label['text']);label['visible']=False
    previous=view.setdefault('dialogBindings',{}).get(window['id']);signature=hashlib.sha256(json.dumps(tree,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    revision=previous['revision']+(signature!=previous['signature']) if previous else 1
    dialog={'source':'native-uno-uitest','revision':revision,'root':tree,'complete':not unsupported}
    if unsupported:dialog['unsupported']=unsupported
    view['dialogBindings'][window['id']]={'instanceId':window['instanceId'],'handle':handle,'root':root,'targets':targets,'signature':signature,'revision':revision}
    window['dialog']=dialog
    if 'Modal' in raw:window['modal']=raw['Modal']=='true'
    return dialog

def native_dialog_reply(session,view,identifier,instance,dialog=None):
    reply={'state':state(session,view),'windowId':identifier,'windowInstanceId':instance}
    if dialog is not None:reply['dialog']=dialog
    return reply

def dialog_action(session,view,args):
    if args.get('engineEpoch')!=epoch:fail('STALE_OFFICE_WINDOW','Office 编辑会话已经变化。')
    request_id=args.get('requestId');action=args.get('action');node_id=args.get('nodeId')
    if not isinstance(request_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',request_id) or not isinstance(node_id,str) or len(node_id)>128 or not isinstance(action,dict) or action.get('kind') not in ['click','set-text','toggle','select']:fail('INVALID_OFFICE_WINDOW_ACTION','Office 对话框操作无效。')
    key='dialog:'+str(args.get('windowInstanceId'))+':'+request_id;signature=hashlib.sha256(json.dumps(args,sort_keys=True,separators=(',',':')).encode()).hexdigest();cached=request_receipt(session,key,signature)
    if cached is not None:return cached
    window=window_for(session,view,args);dialog=read_native_dialog(view,window)
    if dialog is None:fail('OFFICE_WINDOW_CONTROLS_UNAVAILABLE','此 Office 原生窗口没有结构化控件。')
    if type(args.get('revision')) is not int or args['revision']!=dialog['revision']:fail('STALE_OFFICE_WINDOW_CONTROLS','Office 对话框控件已更新，请重新操作。')
    binding=view['dialogBindings'][window['id']];target=binding['targets'].get(node_id);kind=action['kind'];value=action.get('value')
    if not target or kind not in target['actions']:fail('OFFICE_WINDOW_CONTROL_DISABLED','Office 原生控件不存在、已禁用或不支持此操作。')
    current=dialog_native_state(target['object'])
    if current.get('Enabled')!='true' or current.get('Visible')!='true':fail('OFFICE_WINDOW_CONTROL_DISABLED','Office 原生控件已禁用或隐藏。')
    operation='CLICK';values={};text_editor=None
    if kind=='toggle':
        if type(value) is not bool:fail('INVALID_OFFICE_WINDOW_ACTION','Office 开关需要明确的布尔值。')
        if (current.get('Selected')=='true')==value:
            result=native_dialog_reply(session,view,window['id'],window['instanceId'],dialog);remember_request_receipt(session,key,signature,result);return result
    elif kind=='set-text':
        if not isinstance(value,str) or len(value)>65536 or '\0' in value:fail('INVALID_OFFICE_WINDOW_ACTION','Office 控件内容无效。')
        if target['type']=='MultiLineEditUIObject':
            text_editor=target.get('textEditor')
            if text_editor is None:fail('OFFICE_WINDOW_CONTROL_DISABLED','Office 多行控件没有提供可验证的文本编辑接口。')
        else:
            operation='VALUE' if target['type'] in ['MetricFieldUIObject','FormattedFieldUIObject'] else 'SET';values={'VALUE' if operation=='VALUE' else 'TEXT':value}
    elif kind=='select':
        options=target['options'];position=options.get(value) if isinstance(value,str) else None
        if position is None or not 0<=position<len(options):fail('STALE_OFFICE_WINDOW_CONTROLS','Office 原生选项已经更新。')
        # TabControl::SELECT indexes the native page vector directly. Only a
        # refreshed, bounded option token may become its 0-based POS string.
        operation='SELECT';values={'POS':str(position)}
    identifier=window['id'];instance=window['instanceId'];done=threading.Event();outcome={};native=target['object'];native_values=props(values);native_selection=target.get('selection') if kind=='select' else None
    # executeAction schedules an Idle and waits for it. Invoke it on a separate
    # UNO caller thread while this generator yields the real VCL UI loop.
    def invoke():
        try:
            # VerticalTabControl UITest POS indexes a different page vector.
            # Its actual chooser's XAccessibleSelection resolves the selected
            # entry through PageData and invokes the native page-change handler.
            # MultiLineEditUIObject has no SET implementation in the pinned
            # engine. Its exact, ID-bound accessibility peer writes the native
            # virtual Edit::SetText directly, without global keys or clipboard.
            if text_editor is not None:outcome['textAccepted']=bool(text_editor.setText(value))
            elif native_selection is not None:native_selection.selectAccessibleChild(position)
            else:native.executeAction(operation,native_values)
        except BaseException as error:outcome['error']=str(error)
        finally:done.set()
    session.setdefault('requestSignatures',{})[hashlib.sha256(key.encode()).digest()]=signature
    thread=threading.Thread(target=invoke,name='OfficeNativeControlAction',daemon=True);view.setdefault('dialogActionThreads',[]).append((thread,done));session['operationActor']='human';thread.start();deadline=time.monotonic()+8
    try:
        while not done.is_set():
            if time.monotonic()>deadline:
                session['unavailable']=True;fail('OFFICE_WINDOW_ACTION_UNCONFIRMED','Office 原生控件操作尚未确认，未重复执行。')
            yield NativeUiDelay(.005)
        if 'error' in outcome:fail('OFFICE_WINDOW_ACTION_FAILED',outcome['error'])
        if text_editor is not None and outcome.get('textAccepted') is not True:fail('OFFICE_WINDOW_ACTION_REJECTED','Office 未接受多行文本修改。')
        yield;native_event_fence();live=view['windows'].get(identifier)
        dialog=read_native_dialog(view,live) if live and live['instanceId']==instance else None
        if kind=='select' and dialog is not None:
            updated=view['dialogBindings'][identifier]['targets'].get(node_id);fresh=dialog_native_state(updated['object']) if updated else {}
            selected=fresh.get('CurrPagePos' if target['type'] in ['TabControlUIObject','VerticalTabControlUIObject'] else 'SelectEntryPos')
            if selected is not None and int(selected)!=position:fail('OFFICE_WINDOW_ACTION_REJECTED','Office 未接受这个原生选项。')
        if text_editor is not None:
            updated=view['dialogBindings'].get(identifier,{}).get('targets',{}).get(node_id) if dialog is not None else None
            fresh=dialog_native_state(updated['object']) if updated else {}
            normalize=lambda text:str(text).replace('\r\n','\n').replace('\r','\n')
            if 'Text' not in fresh or normalize(fresh['Text'])!=normalize(value):fail('OFFICE_WINDOW_ACTION_REJECTED','Office 多行文本读回与请求不一致，未报告成功。')
        result=native_dialog_reply(session,view,identifier,instance,dialog);remember_request_receipt(session,key,signature,result);return result
    finally:
        session['operationActor']=None;view['dialogActionThreads'][:]=[(worker,event) for worker,event in view['dialogActionThreads'] if not event.is_set()]
`;
