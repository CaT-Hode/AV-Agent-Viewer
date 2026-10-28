/** Shared UNO model definitions for the bundled Kit worker; no standalone window runner. */
export const officeModelSource = String.raw`def fail(code,message): raise RuntimeError(code+'|'+message)

def props(values):
    result=[]
    for name,value in values.items():
        p=uno.createUnoStruct('com.sun.star.beans.PropertyValue');p.Name=name;p.Value=value;result.append(p)
    return tuple(result)

def constant(name,fallback):
    try:return uno.getConstantByName(name)
    except:return fallback

def refresh_content_dirtiness(session):
    dirty=bool(session['doc'].isModified())
    if dirty:session['unsavedContentChanges']=True
    else:session.setdefault('unsavedContentChanges',False)
    return dirty

def saved_ack_notification(session):
    acknowledgement=session.get('acknowledgingSave')
    if acknowledgement is None:return False
    try:return not session['doc'].isModified() and session['engineRevision']==acknowledgement['engineRevision'] and undo_state(session)==acknowledgement['undo']
    except:return False

class Modified(unohelper.Base,XModifyListener):
    def __init__(self,session):self.session=session
    def modified(self,event):
        try:refresh_content_dirtiness(self.session)
        except:pass
        if saved_ack_notification(self.session):return
        self.session['engineRevision']+=1;self.session['actor']=self.session.get('operationActor') or 'human';emit({'type':'changed','sessionId':self.session['sessionId'],'engineRevision':self.session['engineRevision'],'actor':self.session['actor']})
    def disposing(self,event):self.session['disposed']=True;emit({'type':'closed','sessionId':self.session['sessionId']})

class SelectionChanged(unohelper.Base,XSelectionChangeListener):
    def __init__(self,session,view):self.session=session;self.view=view
    def selectionChanged(self,event):
        update_selection_epoch(self.session,self.view,selection(self.session,self.view))
    def disposing(self,event):self.view['disposed']=True

class DocumentEvents(unohelper.Base,XDocumentEventListener):
    def __init__(self,session):self.session=session
    def documentEventOccured(self,event):
        if not self.session.get('exporting') and event.EventName in ['OnSaveDone','OnSaveAsDone']:emit({'type':'saved','sessionId':self.session['sessionId'],'engineRevision':self.session['engineRevision']})
    def disposing(self,event):pass

class Status(unohelper.Base,XStatusListener):
    def __init__(self):self.received=False;self.enabled=False;self.value=None
    def statusChanged(self,event):
        self.received=True;self.enabled=bool(event.IsEnabled);self.value=event.State if isinstance(event.State,(str,int,float,bool)) else None
    def disposing(self,event):pass

class SafeImportInteraction(unohelper.Base,XInteractionHandler):
    def handle(self,request):
        # Imports must not approve repair, macros, external links or credential prompts.
        for continuation in request.getContinuations():
            try:types=[v.typeName for v in continuation.getTypes()]
            except:types=[]
            if 'com.sun.star.task.XInteractionAbort' in types or 'com.sun.star.task.XInteractionDisapprove' in types:
                continuation.select();emit({'type':'diagnostic','code':'NATIVE_IMPORT_INTERACTION_ABORTED'});return
        fail('NATIVE_IMPORT_INTERACTION','文档导入需要明确处理的交互，未自动批准。')

MANAGED_ACTIONS={'.uno:Save':'save','.uno:SaveAs':'save-as','.uno:SaveAll':'save-all','.uno:Open':'open','.uno:OpenUrl':'open','.uno:NewDoc':'new','.uno:CloseDoc':'close','.uno:CloseWin':'close','.uno:Quit':'quit','.uno:NewWindow':'new-window'}

class ManagedDispatch(unohelper.Base,XDispatch):
    def __init__(self,view,command):self.view=view;self.command=command
    def dispatch(self,target,args):emit({'type':'application-action','sessionId':self.view['sessionId'],'viewId':self.view['viewId'],'action':MANAGED_ACTIONS[self.command]})
    def addStatusListener(self,listener,target):
        event=uno.createUnoStruct('com.sun.star.frame.FeatureStateEvent');event.Source=self;event.FeatureURL=target;event.IsEnabled=True;event.State=None;listener.statusChanged(event)
    def removeStatusListener(self,listener,target):pass

class ManagedInterceptor(unohelper.Base,XDispatchProviderInterceptor):
    def __init__(self,view):self.view=view;self.slave=None;self.master=None;self.dispatches={}
    def queryDispatch(self,target,name,flags):
        command=target.Complete
        if command in MANAGED_ACTIONS and not self.view.get('internalManaged'):
            if command not in self.dispatches:self.dispatches[command]=ManagedDispatch(self.view,command)
            return self.dispatches[command]
        return self.slave.queryDispatch(target,name,flags) if self.slave else None
    def queryDispatches(self,descriptors):return tuple(self.queryDispatch(d.FeatureURL,d.FrameName,d.SearchFlags) for d in descriptors)
    def setSlaveDispatchProvider(self,provider):self.slave=provider
    def getSlaveDispatchProvider(self):return self.slave
    def setMasterDispatchProvider(self,provider):self.master=provider
    def getMasterDispatchProvider(self):return self.master

class DispatchCompleted(unohelper.Base,XDispatchResultListener):
    def __init__(self,session,view,request_id):self.session=session;self.view=view;self.request_id=request_id
    def dispatchFinished(self,event):
        self.view.get('pendingDispatches',{}).pop(self.request_id,None)
        emit({'type':'dispatch-finished','sessionId':self.session['sessionId'],'viewId':self.view['viewId'],'requestId':self.request_id,'resultState':int(event.State),'engineRevision':self.session['engineRevision']})
    def disposing(self,event):self.view.get('pendingDispatches',{}).pop(self.request_id,None)

def url(command):
    value=uno.createUnoStruct('com.sun.star.util.URL');value.Complete=command
    try:
        parsed=transformer.parseStrict(value)
        if isinstance(parsed,tuple) and len(parsed)>1:value=parsed[1]
    except:pass
    return value

def command_status(view,command):
    try:
        target=url(command);dispatch=view['frame'].queryDispatch(target,'',0)
        if dispatch is None:return {'command':command,'available':False,'enabled':False}
        listener=Status();dispatch.addStatusListener(listener,target);dispatch.removeStatusListener(listener,target)
        return {'command':command,'available':True,'enabled':listener.enabled if listener.received else False,'state':listener.value}
    except:return {'command':command,'available':False,'enabled':False}

def expected(session,view,args):
    if args.get('expectedEngineEpoch') is not None and args['expectedEngineEpoch']!=epoch:fail('ENGINE_EPOCH_CHANGED','原生引擎已经重启，请重新读取。')
    if args.get('expectedEngineRevision')!=session['engineRevision']:fail('REVISION_CONFLICT','原生文档已变化，请重新读取。')
    if args.get('expectedSelectionEpoch') is not None:
        selected=selection(session,view);update_selection_epoch(session,view,selected,False)
        if args.get('style',{}).get('target') in ['text','paragraph','shape'] and selected.get('identityUnavailable'):fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生目标没有可验证的范围身份。')
        if args['expectedSelectionEpoch']!=view['selectionEpoch']:fail('SELECTION_CHANGED','原生选区已变化，请重新读取。')

def letter(column):
    value='';column+=1
    while column:column,remainder=divmod(column-1,26);value=chr(65+remainder)+value
    return value

def range_name(address):
    start=letter(address.StartColumn)+str(address.StartRow+1);end=letter(address.EndColumn)+str(address.EndRow+1)
    return start if start==end else start+':'+end

def selected_text_range(session,view):
    if session['format'] not in ['docx','pptx']:return None
    try:
        selected=view['controller'].getSelection()
        if session['format']=='docx':
            if selected.getCount()!=1:return None
            selected=selected.getByIndex(0)
        elif hasattr(selected,'getCount'):return None # Selected objects are not a text editing range.
        value=selected.queryInterface(uno.getTypeByName('com.sun.star.text.XTextRange'))
        if value is None or not value.getString() or len(value.getString())>48000:return None
        return value
    except:return None

def selection_actions(session,view,selected):
    if selected['kind']!='text' or not selected['text']:return []
    actions=[]
    for action,command in [('bold','.uno:Bold'),('italic','.uno:Italic'),('underline','.uno:Underline'),('strike','.uno:Strikeout'),('align-left','.uno:LeftPara'),('align-center','.uno:CenterPara')]:
        if command_status(view,command)['enabled']:actions.append(action)
    value=selected_text_range(session,view)
    if value is not None and value.getString()==selected['text']:actions.append('replace')
    return actions

def ppt_text_parts(full,positions):
    full=full.replace('\r\n','\n').replace('\r','\n');lines=full.split('\n');offsets=[]
    for paragraph,position in [positions[:2],positions[2:]]:
        if paragraph>=len(lines) or position>len(lines[paragraph].encode('utf-16-le'))//2:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','实际文字范围超出对象内容。')
        offsets.append(sum(len(line.encode('utf-16-le'))//2+1 for line in lines[:paragraph])+position)
    encoded=full.encode('utf-16-le')
    try:return tuple(encoded[a*2:b*2].decode('utf-16-le') for a,b in [(0,offsets[0]),(offsets[0],offsets[1]),(offsets[1],len(encoded)//2)])
    except UnicodeError:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','实际文字范围没有完整字符边界。')

def ppt_text_transaction_target(session,view,value,whole_shape=False):
    text=value.Text;shape=text.queryInterface(uno.getTypeByName('com.sun.star.drawing.XShape'));page=view['controller'].getCurrentPage()
    if shape is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字范围不属于可验证的真实幻灯片对象。')
    try:index=shape.getPropertyValue('ZOrder')
    except:index=-1
    if type(index) is not int or index<0 or index>=page.getCount() or page.getByIndex(index)!=shape:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字对象不属于该页的唯一顶层对象。')
    pages=session['doc'].getDrawPages();slide=next((i for i in range(pages.getCount()) if pages.getByIndex(i)==page),None)
    if slide is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前幻灯片身份不可用。')
    native=value.getPropertyValue('Selection');positions=[native.Start.Paragraph,native.Start.PositionInParagraph,native.End.Paragraph,native.End.PositionInParagraph]
    if any(type(v) is not int or v<0 for v in positions) or tuple(positions[:2])>tuple(positions[2:]):fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生文字范围位置无效。')
    full=text.getString()
    if not whole_shape and len(full.encode('utf-16-le'))//2>48000:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字对象超出可验证的字符范围。')
    prefix,selected,suffix=ppt_text_parts(full,positions);actual=value.getString()
    if selected!=actual.replace('\r\n','\n').replace('\r','\n'):fail('SELECTION_CHANGED','实际文字范围与对象内容不一致。')
    return {'text':text,'shape':shape,'page':page,'index':index,'slide':slide,'nativeSelection':native,'positions':positions,'expectedText':actual,'fullText':full,'prefix':prefix,'suffix':suffix}

def ppt_text_model_range(session,view,target,args):
    # Official SdUnoDrawView::setCurrentPage always commits SdrEndTextEdit, even
    # for the same page. An active viewless UNO cursor otherwise edits a copy
    # which the live Outliner immediately replaces on the next getter.
    view['controller'].setCurrentPage(target['page'])
    expected(session,view,{key:value for key,value in args.items() if key!='expectedSelectionEpoch'})
    page=view['controller'].getCurrentPage()
    if page!=target['page'] or target['index']>=page.getCount() or page.getByIndex(target['index'])!=target['shape']:fail('SELECTION_CHANGED','真实文字对象已变化，没有猜测目标。')
    if target['shape'].getText().getString()!=target['fullText']:fail('SELECTION_CHANGED','结束编辑后对象内容已变化，没有继续修改。')
    model=target['shape'].getText().createTextCursor();model.setPropertyValue('Selection',target['nativeSelection'])
    if model.getString()!=target['expectedText']:fail('SELECTION_CHANGED','结束编辑后真实文字范围已变化，没有继续修改。')
    return model

def ppt_replace_text(session,view,target,replacement,args):
    model=ppt_text_model_range(session,view,target,args)
    if model.getString()!=replacement['expectedText']:fail('SELECTION_CHANGED','实际文字范围已变化，没有替换。')
    command='.uno:TransformDocumentStructure';dispatch=view['frame'].queryDispatch(url(command),'',0)
    if dispatch is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生引擎不提供绑定对象的文字编辑事务。')
    # This fixed typed payload never accepts caller JSON or nested UnoCommand.
    payload={'Transforms':[{'SlideCommands':[{'JumpToSlide':target['slide']},{'EditTextObject.'+str(target['index']):[{'SelectText':target['positions']},{'InsertText':replacement['text']}]}]}]}
    dispatcher.executeDispatch(view['frame'],command,'',0,props({'DataJson':urllib.parse.quote(json.dumps(payload,ensure_ascii=False),safe=''),'SynchronMode':True}))
    changed=target['shape'].getText().createTextCursor();changed.gotoStart(False);changed.gotoEnd(True)
    native=uno.createUnoStruct('com.sun.star.text.TextRangeSelection');native.Start=target['nativeSelection'].Start;parts=replacement['text'].replace('\r\n','\n').replace('\r','\n').split('\n')
    # PyUNO nested structs are returned by value: mutating native.End.* would
    # mutate a temporary copy. Assign the complete real TextPosition instead.
    end=uno.createUnoStruct('com.sun.star.text.TextPosition');end.Paragraph=native.Start.Paragraph+len(parts)-1;end.PositionInParagraph=(native.Start.PositionInParagraph if len(parts)==1 else 0)+len(parts[-1].encode('utf-16-le'))//2;native.End=end
    inserted=target['shape'].getText().createTextCursor();inserted.setPropertyValue('Selection',native)
    normalized=replacement['text'].replace('\r\n','\n').replace('\r','\n')
    if inserted.getString().replace('\r\n','\n').replace('\r','\n')!=normalized:fail('NATIVE_STYLE_APPLY_FAILED','原生文字事务没有产生可验证的替换结果。')
    if changed.getString().replace('\r\n','\n').replace('\r','\n')!=target['prefix']+normalized+target['suffix']:fail('NATIVE_STYLE_APPLY_FAILED','原生文字对象的替换或未选中内容未通过验证，未报告成功。')

def ppt_set_shape_text(session,view,op,args):
    # Viewless SvxShapeText::setString updates an Nbc text copy without native
    # document undo/modify notifications. Use the same real Outliner transaction
    # as selection replacement, after binding the entire actual top-level shape.
    if args.get('background') or args.get('actor','agent')=='agent':
        page,shape=mapped_shape(session,op['slideId'],op['shapeId']);index=mapped_slide(session,op['slideId'])[1];position=next((position for position in range(page.getCount()) if page.getByIndex(position)==shape),None)
        if position is None:fail('INVALID_TARGET','原生顶层文字对象已经变化。')
        return authoring_replace_slide_text(session,view,{'slideIndex':index,'objectPath':[position],'expectedText':shape.getText().getString(),'text':op['text']},args)
    for candidate in session['views'].values():
        if candidate.get('disposed'):continue
        cached=candidate.get('accessibilityCache',{}).get('data')
        if own_ime_pending(candidate) or candidate.get('nativeEditing') or candidate.get('caretVisible') or cached and cached[2]:fail('NATIVE_PENDING_INPUT','幻灯片文字输入尚未提交，没有隐式结束另一视图的编辑。')
        if not candidate['frame'].getContainerWindow().isEnabled():fail('NATIVE_PENDING_INPUT','原生对话框尚未结束。')
    page,shape=mapped_shape(session,op['slideId'],op['shapeId'])
    try:
        if shape.supportsService('com.sun.star.drawing.GroupShape'):fail('NATIVE_STYLE_TARGET_UNAVAILABLE','组合对象不能作为唯一顶层文字目标。')
        text=shape.getText();full=text.getString();index=shape.getPropertyValue('ZOrder')
    except RuntimeError:raise
    except:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前对象不是可验证的原生文字对象。')
    if type(index) is not int or index<0 or index>=page.getCount() or page.getByIndex(index)!=shape:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字对象不属于该页的唯一顶层对象。')
    if full==op['text']:return
    # Changing the page may retire a live Outliner. The all-view guard above
    # forbids pending input, and identity/content/version must still agree after it.
    view['controller'].setCurrentPage(page)
    expected(session,view,{key:value for key,value in args.items() if key!='expectedSelectionEpoch'})
    actual_page,actual_shape=mapped_shape(session,op['slideId'],op['shapeId'])
    if actual_page!=page or actual_shape!=shape or shape.getText().getString()!=full:fail('SELECTION_CHANGED','真实文字对象或全文已变化，没有猜测目标。')
    value=text.createTextCursor();value.gotoStart(False);value.gotoEnd(True)
    target=ppt_text_transaction_target(session,view,value,True)
    if target['shape']!=shape or target['page']!=page or target['index']!=index or target['fullText']!=full or target['prefix'] or target['suffix']:fail('SELECTION_CHANGED','原生全文范围不完整，没有替换。')
    ppt_replace_text(session,view,target,{'expectedText':value.getString(),'text':op['text']},args)

def replace_selected_text(session,view,replacement,args=None):
    value=selected_text_range(session,view)
    if value is None:fail('NATIVE_SELECTION_UNSUPPORTED','当前选区不是可直接编辑的实际文字范围。')
    if value.getString()!=replacement['expectedText']:fail('SELECTION_CHANGED','实际选区文字已变化，未替换。')
    if session['format']=='pptx':
        target=ppt_text_transaction_target(session,view,value);ppt_replace_text(session,view,target,replacement,args or {})
    else:value.setString(replacement['text'])

def selection_signature(selected):
    locator=selected.get('locator',{})
    return (selected['kind'],selected['text'],selected.get('sheetName'),selected.get('range'),selected.get('slideIndex'),tuple(selected.get('objectNames',[])),locator.get('from'),locator.get('to'),locator.get('cell'),locator.get('blockId'),bool(selected.get('identityUnavailable')))

def update_selection_epoch(session,view,selected,notify=True):
    signature=selection_signature(selected)
    if view.get('semanticSelection')==signature:return False
    view['semanticSelection']=signature;view['selectionEpoch']+=1;view['actor']=session.get('operationActor') or 'human'
    view.pop('accessibilityCache',None);view.pop('captureCache',None)
    if notify:emit({'type':'selection','sessionId':session['sessionId'],'viewId':view['viewId'],'engineRevision':session['engineRevision'],'actor':view['actor']})
    return True

def native_text_container_id(session,text):
    containers=session.setdefault('textContainers',[])
    for item in containers:
        if item['text']==text:return item['id']
    if len(containers)>=2048:fail('NATIVE_SELECTION_UNSUPPORTED','原生文字容器数量超出可验证范围。')
    identity='native-text-container:'+str(uuid.uuid4());containers.append({'text':text,'id':identity});return identity

def native_shape_identity(session,shape):
    objects=session.setdefault('shapeIdentities',[])
    for item in objects:
        if item['shape']==shape:return item['id']
    if len(objects)>=4096:fail('NATIVE_SELECTION_UNSUPPORTED','原生对象数量超出可验证范围。')
    identity='native-shape:'+str(uuid.uuid4());objects.append({'shape':shape,'id':identity});return identity

def native_range_locator(session,view,actual,content):
    text=actual.Text;identity=native_text_container_id(session,text);revision=session['engineRevision'];cache=view.setdefault('rangeLocatorCache',[])
    comparable=hasattr(text,'compareRegionStarts') and hasattr(text,'compareRegionEnds')
    if not comparable and session['format']!='pptx':fail('NATIVE_SELECTION_UNSUPPORTED','原生文字容器不提供精确范围比较。')
    for item in cache:
        if item['revision']!=revision or item['container']!=identity:continue
        try:
            if text.compareRegionStarts(actual,item['range'])==0 and text.compareRegionEnds(actual,item['range'])==0:return dict(item['locator'])
        except:pass
    # Writer viewport polls compare retained model ranges without rereading their
    # document prefix. Impress XText lacks that interface: read only the actual
    # selected shape's bounded prefix, never the presentation's combined body.
    prefix=text.createTextCursorByRange(actual.getStart());prefix.gotoStart(True);start=len(prefix.String.encode('utf-16-le'))//2
    end=start+len(content.encode('utf-16-le'))//2
    if not comparable and end>48000:fail('NATIVE_SELECTION_UNSUPPORTED','当前原生对象文字范围超过可验证的字符限制。')
    locator={'blockId':identity,'from':start,'to':end}
    if comparable:
        anchor=text.createTextCursorByRange(actual.getStart());anchor.gotoRange(actual.getEnd(),True)
        cache[:]=[item for item in cache if item['revision']==revision][-63:];cache.append({'revision':revision,'container':identity,'range':anchor,'locator':locator})
    return dict(locator)

def selection(session,view):
    controller=view['controller'];result={'kind':'none','text':''}
    try:
        selected=controller.getSelection()
        if session['format']=='xlsx':
            address=selected.getRangeAddress();sheet=controller.getActiveSheet();area=(address.EndColumn-address.StartColumn+1)*(address.EndRow-address.StartRow+1);text='\n'.join('\t'.join(str(v) for v in row) for row in selected.getDataArray())[:48000] if area<=2000 else '';result={'kind':'cells','text':text,'sheetIndex':address.Sheet,'sheetName':sheet.Name,'range':range_name(address)}
        elif session['format']=='docx':
            count=selected.getCount()
            if count>64:fail('NATIVE_SELECTION_UNSUPPORTED','原生文字范围数量超出可验证范围。')
            actuals=[selected.getByIndex(i) for i in range(count)] or [controller.getViewCursor()];pieces=[actual.getString() for actual in actuals];content='\n'.join(pieces);cursor=controller.getViewCursor()
            result={'kind':'text' if content else 'none','text':content[:48000],'pageIndex':max(0,cursor.getPage()-1),'locator':{'kind':'native-text','pageIndex':max(0,cursor.getPage()-1),'quote':content[:240]}}
            try:
                ranges=[native_range_locator(session,view,actual,piece) for actual,piece in zip(actuals,pieces)]
                result['locator'].update(ranges[0])
                if len(ranges)>1:result['locator']['blockId']='native-ranges:'+hashlib.sha256(json.dumps(ranges,sort_keys=True).encode()).hexdigest()
                if getattr(cursor,'Cell',None) is not None:result['locator']['cell']=cursor.Cell.CellName
            except:result['identityUnavailable']=True
        else:
            pages=session['doc'].getDrawPages();page=controller.getCurrentPage();index=next((i for i in range(pages.getCount()) if pages.getByIndex(i)==page),0)
            if selected is not None and hasattr(selected,'getCount'):
                # Impress getSelection falls back to marked shapes when its
                # active Outliner has only a caret (e.g. after text Undo).
                # That fallback never proves an object or full-text selection.
                if view.get('nativeEditing') or view.get('caretVisible'):return {'kind':'none','text':'','slideIndex':index}
                objects=[selected.getByIndex(i) for i in range(min(selected.getCount(),100))];result={'kind':'objects' if objects else 'none','text':'\n'.join(getattr(v,'String','') for v in objects)[:48000],'slideIndex':index,'objectNames':[getattr(v,'Name','') for v in objects]}
                try:
                    if selected.getCount()>100:fail('NATIVE_SELECTION_UNSUPPORTED','所选对象数量超出可验证范围。')
                    if objects:result['locator']={'kind':'native-shapes','slideId':str(index),'blockId':hashlib.sha256(json.dumps([native_shape_identity(session,value) for value in objects]).encode()).hexdigest()}
                except:result['identityUnavailable']=True
            elif selected is not None and hasattr(selected,'getString'):
                content=selected.getString();result={'kind':'text' if content else 'none','text':content[:48000],'slideIndex':index,'locator':{'kind':'native-text','slideId':str(index),'quote':content[:240]}}
                try:result['locator'].update(native_range_locator(session,view,selected,content))
                except:result['identityUnavailable']=True
            else:result['slideIndex']=index
    except:
        if session['format'] in ['docx','pptx']:result['identityUnavailable']=True
    return result

def undo_state(session):
    try:
        manager=session['doc'].getUndoManager();titles=list(manager.getAllUndoActionTitles());redo=manager.isRedoPossible();title=manager.getCurrentUndoActionTitle() if titles else None
        token=hashlib.sha256(json.dumps([session['engineRevision'],titles],ensure_ascii=False).encode()).hexdigest()
        return {'canUndo':manager.isUndoPossible(),'canRedo':redo,'title':title,'count':len(titles),'token':token}
    except:return {'canUndo':False,'canRedo':False,'count':0,'token':''}

def sheet_by_name(session,name):
    if session['format']!='xlsx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是工作簿。')
    sheets=session['doc'].getSheets()
    if not sheets.hasByName(name):fail('INVALID_TARGET','工作表名称已变化。')
    return sheets.getByName(name)

def checked_range(sheet,name):
    if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?',name):fail('INVALID_TARGET','单元格范围无效。')
    value=sheet.getCellRangeByName(name);address=value.getRangeAddress()
    if (address.EndColumn-address.StartColumn+1)*(address.EndRow-address.StartRow+1)>10000:fail('NATIVE_QUERY_LIMIT','一次读取最多一万个单元格。')
    return value

def excel_formula_parser(session):
    parser=session.get('excelFormulaParser')
    if parser is not None:return parser
    try:
        parser=session['doc'].createInstance('com.sun.star.sheet.FormulaParser')
        mapper=session['doc'].createInstance('com.sun.star.sheet.FormulaOpCodeMapper')
        parser.CompileEnglish=True
        parser.FormulaConvention=constant('com.sun.star.sheet.AddressConvention.XL_A1',1)
        # Some bundled implementations omit this documented property. The native
        # XL_ENGLISH OpCodeMap below also defines the Excel comma separator.
        if parser.getPropertySetInfo().hasPropertyByName('ParameterSeparator'):parser.ParameterSeparator=','
        parser.OpCodeMap=mapper.getAvailableMappings(constant('com.sun.star.sheet.FormulaLanguage.XL_ENGLISH',4),constant('com.sun.star.sheet.FormulaMapGroup.ALL_EXCEPT_SPECIAL',0x7fffffff))
    except:fail('NATIVE_FORMULA_UNAVAILABLE','原生 Excel 公式解析器不可用，没有降级改写公式字符。')
    session['excelFormulaParser']=parser
    return parser

def set_excel_formula(session,cell,text):
    if not isinstance(text,str) or not text or len(text)>100000:fail('INVALID_NATIVE_FORMULA','公式内容无效。')
    formula=text if text.startswith('=') else '='+text
    try:
        tokens=excel_formula_parser(session).parseFormula(formula,cell.getCellAddress())
        if not tokens:fail('INVALID_NATIVE_FORMULA','公式没有有效的原生 token。')
        cell.setTokens(tokens)
    except RuntimeError:raise
    except:fail('INVALID_NATIVE_FORMULA','原生 Excel 公式解析或写入失败。')

def set_cell_content(session,cell,content):
    if content.startswith('=') and len(content)>1:set_excel_formula(session,cell,content)
    else:cell.setFormula(content) # Preserve native interpretation of non-formula input.

def excel_cell_formula(session,cell):
    if cell.getType().value!='FORMULA':return cell.getFormula()
    try:
        value=excel_formula_parser(session).printFormula(cell.getTokens(),cell.getCellAddress())
        return value if value.startswith('=') else '='+value
    except:fail('NATIVE_FORMULA_READ_FAILED','原生公式无法按 Excel 语法读取。')

def query_cell_range(session,cells):
    address=cells.getRangeAddress();formulas=[];errors=[];kinds=[];logical=[];values=[list(row) for row in cells.getDataArray()];formats={}
    for row in range(address.EndRow-address.StartRow+1):
        formula_row=[];error_row=[];kind_row=[];logical_row=[]
        for column in range(address.EndColumn-address.StartColumn+1):
            cell=cells.getCellByPosition(column,row);formula_row.append(excel_cell_formula(session,cell));error_row.append(int(cell.getError()))
            kind=cell.getType().value
            numeric=kind=='VALUE';result_type=None
            if kind=='FORMULA':
                try:result_type=cell.getPropertyValue('FormulaResultType').value;numeric=result_type=='VALUE'
                except:pass
            if numeric:
                key=int(cell.NumberFormat)
                if key not in formats:formats[key]=int(session['doc'].getNumberFormats().getByKey(key).Type)
                is_logical=bool(formats[key]&constant('com.sun.star.util.NumberFormat.LOGICAL',1024))
            else:is_logical=None if kind=='FORMULA' and result_type is None else False
            if cell.getError():is_logical=False
            if is_logical and cell.getValue() in [0.,1.]:values[row][column]=bool(cell.getValue())
            kind_row.append('formula' if kind=='FORMULA' else 'logical' if is_logical else {'EMPTY':'empty','VALUE':'number','TEXT':'text'}.get(kind,'unknown'))
            logical_row.append(is_logical)
        formulas.append(formula_row);errors.append(error_row);kinds.append(kind_row);logical.append(logical_row)
    # Calc ISLOGICAL(reference) checks numeric native content plus LOGICAL
    # number format. FormulaResultType keeps text/error formulas from becoming
    # booleans. Noncanonical numeric values (e.g. 42 with BOOLEAN) stay intact.
    return {'values':values,'formulas':formulas,'errors':errors,'kinds':kinds,'logical':logical,'logicalCoverage':'native-number-format'}

def query(session,view,target):
    doc=session['doc'];kind=target['kind'];controller=view['controller']
    if kind=='style':
        selected=selection(session,view);update_selection_epoch(session,view,selected)
        if target['target'] in ['text','paragraph','shape'] and selected.get('identityUnavailable'):return {'targetKind':target['target'],'fields':{name:{'value':None,'state':'unsupported','available':False,'reason':'当前原生目标没有可验证的范围身份。'} for name in STYLE_FIELDS[target['target']]}}
        return inspect_native_style(session,view,target['target'])
    if kind=='selection':return selection(session,view)
    if kind=='document':
        result={'format':session['format'],'title':getattr(doc,'Title','')}
        if session['format']=='docx':result.update(text=doc.Text.String,pageCount=getattr(controller,'PageCount',None))
        elif session['format']=='xlsx':result['sheetCount']=doc.getSheets().getCount()
        else:result['slideCount']=doc.getDrawPages().getCount()
        return result
    if kind=='sheets':
        if session['format']!='xlsx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是工作簿。')
        sheets=doc.getSheets();active=controller.getActiveSheet();items=[]
        for index in range(sheets.getCount()):
            sheet=sheets.getByIndex(index);cursor=sheet.createCursor();cursor.gotoEndOfUsedArea(False);area=cursor.getRangeAddress();items.append({'index':index,'name':sheet.Name,'visible':sheet.IsVisible,'rowCount':area.EndRow+1,'columnCount':area.EndColumn+1})
        return {'sheets':items,'activeIndex':next((i for i in range(sheets.getCount()) if sheets.getByIndex(i)==active),0)}
    if kind=='cell-range':
        cells=checked_range(sheet_by_name(session,target['sheetName']),target['range']);return {'sheetName':target['sheetName'],'range':target['range'],**query_cell_range(session,cells)}
    if kind=='slide-thumbnails':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        indices=target.get('indices');source=slide_thumbnail_source(session)
        if not session.get('slideThumbnailHistoryVerified'):fail('NATIVE_QUERY_UNSUPPORTED','此后端无法验证可复用的缩略图来源，请使用完整幻灯片查询。')
        if not isinstance(indices,list) or not 1<=len(indices)<=3 or any(type(index) is not int or not 0<=index<10000 for index in indices) or len(set(indices))!=len(indices):fail('INVALID_NATIVE_QUERY','请提供1至3个不重复的0-based幻灯片索引。')
        if not isinstance(target.get('source'),dict) or target['source']!=source:fail('STALE_NATIVE_THUMBNAIL','幻灯片来源已变化，请重新读取页面列表。')
        if slide_thumbnail_pending(session,view):fail('NATIVE_PENDING_INPUT','请先完成此文档各视图中的输入，再生成缩略图。')
        pages=doc.getDrawPages()
        if any(index>=pages.getCount() for index in indices):fail('INVALID_TARGET','目标幻灯片不可用。')
        items=[]
        for index in indices:
            thumbnail=slide_thumbnail(session,pages.getByIndex(index),index,source)
            if not thumbnail:
                if slide_thumbnail_pending(session,view):fail('NATIVE_PENDING_INPUT','生成缩略图期间此文档仍有未完成输入，请稍后重试。')
                if source!=slide_thumbnail_source(session):fail('STALE_NATIVE_THUMBNAIL','生成缩略图期间幻灯片来源已变化，请重新读取页面列表。')
                fail('NATIVE_THUMBNAIL_UNAVAILABLE','原生引擎未能生成所请求的幻灯片缩略图。')
            items.append({'index':index,'thumbnail':thumbnail})
        if slide_thumbnail_pending(session,view):fail('NATIVE_PENDING_INPUT','生成缩略图期间此文档仍有未完成输入，请稍后重试。')
        if source!=slide_thumbnail_source(session):fail('STALE_NATIVE_THUMBNAIL','生成缩略图期间幻灯片来源已变化，请重新读取页面列表。')
        return {'source':source,'slides':items}
    if kind=='slides':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        if 'includeThumbnails' in target and type(target['includeThumbnails']) is not bool:fail('INVALID_NATIVE_QUERY','includeThumbnails必须为布尔值。')
        include_thumbnails=target.get('includeThumbnails',True);pages=doc.getDrawPages();active=controller.getCurrentPage();items=[];source=slide_thumbnail_source(session)
        if not include_thumbnails and not session.get('slideThumbnailHistoryVerified'):fail('NATIVE_QUERY_UNSUPPORTED','此后端无法验证可复用的缩略图来源，请使用完整幻灯片查询。')
        for index in range(pages.getCount()):
            page=pages.getByIndex(index);item={'index':index,'name':page.Name,'width':page.Width,'height':page.Height,'text':'\n'.join(getattr(page.getByIndex(i),'String','') for i in range(page.getCount()))}
            if include_thumbnails and index<40:
                thumbnail=slide_thumbnail(session,page,index,source)
                if thumbnail:item['thumbnail']=thumbnail
            items.append(item)
        result={'slides':items,'activeIndex':next((i for i in range(pages.getCount()) if pages.getByIndex(i)==active),0)}
        if not include_thumbnails:
            if source!=slide_thumbnail_source(session):fail('STALE_NATIVE_THUMBNAIL','读取列表期间幻灯片来源已变化，请重新读取。')
            result['thumbnailSource']=source
        return result
    if kind=='shapes':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        pages=doc.getDrawPages();index=target['slideIndex']
        if not isinstance(index,int) or isinstance(index,bool) or index<0 or index>=pages.getCount():fail('INVALID_TARGET','目标幻灯片不可用。')
        page=pages.getByIndex(index);total=page.getCount();objects=[]
        for i in range(min(total,500)):
            shape=page.getByIndex(i);position=shape.getPosition();size=shape.getSize();text=getattr(shape,'String','')
            objects.append({'name':getattr(shape,'Name',''),'type':shape.ShapeType,'text':text[:2000],'textTruncated':len(text)>2000,'bounds':{'x':position.X,'y':position.Y,'width':size.Width,'height':size.Height}})
        return {'slideIndex':index,'total':total,'objects':objects,'truncated':total>500,'unit':'1/100mm'}
    if kind=='shape':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        page=doc.getDrawPages().getByIndex(target['slideIndex']);found=[page.getByIndex(i) for i in range(page.getCount()) if getattr(page.getByIndex(i),'Name','')==target['name']]
        if len(found)!=1:fail('INVALID_TARGET','对象名称不唯一或已经变化。')
        shape=found[0];return {'name':shape.Name,'text':getattr(shape,'String',''),'type':shape.ShapeType,'bounds':{'x':shape.Position.X,'y':shape.Position.Y,'width':shape.Size.Width,'height':shape.Size.Height},'readOnly':False}
    if kind=='properties':
        value=doc if target['target']=='document' else controller.getSelection()
        try:info=value.getPropertySetInfo();properties=info.getProperties()
        except:fail('NATIVE_QUERY_UNSUPPORTED','此目标没有可查询属性。')
        names=target.get('names');items=[]
        for p in properties:
            if names and p.Name not in names:continue
            try:
                item=value.getPropertyValue(p.Name)
                if isinstance(item,(str,int,float,bool)) or item is None:items.append({'name':p.Name,'type':p.Type.typeName,'value':item,'readOnly':bool(p.Attributes&16)})
            except:pass
        return {'target':target['target'],'properties':items}
    fail('NATIVE_QUERY_UNSUPPORTED','此原生查询尚未接入。')

def slide_thumbnail_pending(session,view):
    return any(not item.get('disposed') and (own_ime_pending(item) or item.get('nativeEditing') or item.get('caretVisible')) for item in session.get('views',{'target':view}).values())

def slide_thumbnail_source(session):
    if globals().get('refresh_pending_surface_geometries'):refresh_pending_surface_geometries(session)
    pages=session['doc'].getDrawPages();geometry=[(page.Name,page.Width,page.Height) for page in (pages.getByIndex(index) for index in range(pages.getCount()))]
    appearance=globals().get('native_appearance')
    digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()
    # Native Outliner history covers changes that have not yet delivered a
    # modification callback. View paint/selection generations are deliberately
    # excluded: changing the current slide or zoom does not alter slide content.
    try:
        manager=session['doc'].getUndoManager();history=[list(manager.getAllUndoActionTitles()),list(manager.getAllRedoActionTitles())];session['slideThumbnailHistoryVerified']=True
    except:
        history=None;session['slideThumbnailHistoryVerified']=False
        session.pop('slideThumbnails',None);session.pop('slideThumbnailBytes',None);session.pop('slideThumbnailSource',None)
    return {'documentId':session['documentId'],'sessionId':session['sessionId'],'engineEpoch':epoch,'engineRevision':session['engineRevision'],'partGeometryGeneration':session.get('partGeometryGeneration',0),'appearanceKey':digest(appearance),'geometryKey':digest(geometry),'renderKey':digest(history)}

def slide_thumbnail(session,page,index,source=None):
    source=source if source is not None else slide_thumbnail_source(session);scope=json.dumps(source,sort_keys=True,separators=(',',':'))
    if session.get('slideThumbnailSource')!=scope:
        session['slideThumbnails']={};session['slideThumbnailBytes']=0;session['slideThumbnailSource']=scope
    cache=session.setdefault('slideThumbnails',{});key=index
    if session.get('slideThumbnailHistoryVerified') and not slide_thumbnail_pending(session,{}) and key in cache:return cache[key]
    path=ROOT/('thumbnail-'+uuid.uuid4().hex+'.png')
    try:
        export=sm.createInstanceWithContext('com.sun.star.drawing.GraphicExportFilter',ctx);export.setSourceDocument(page)
        options=props({'PixelWidth':320,'PixelHeight':max(1,round(320*page.Height/page.Width)),'Translucent':False})
        if not export.filter(props({'URL':path.as_uri(),'MediaType':'image/png','FilterData':options})):return None
        data=path.read_bytes()
        if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data)>2*1024*1024:return None
        value='data:image/png;base64,'+base64.b64encode(data).decode()
        if source!=slide_thumbnail_source(session):return None
        # Older backends without a readable history still render freshly, but
        # cannot establish a reusable content receipt from a guessed revision.
        if not session.get('slideThumbnailHistoryVerified') or slide_thumbnail_pending(session,{}):return value
        cache[key]=value;session['slideThumbnailBytes']=session.get('slideThumbnailBytes',0)+len(value)
        while len(cache)>64 or session['slideThumbnailBytes']>8*1024*1024:
            removed=cache.pop(next(iter(cache)));session['slideThumbnailBytes']-=len(removed)
        return value
    except:return None
    finally:
        try:path.unlink()
        except:pass

def model_parts(session):return zipfile.ZipFile(io.BytesIO(session['mappingBytes']))

def native_paragraphs(text):
    result=[];enumeration=text.createEnumeration()
    while enumeration.hasMoreElements():
        item=enumeration.nextElement()
        if item.supportsService('com.sun.star.text.TextTable'):
            names=list(item.getCellNames())
            def key(name):
                match=re.fullmatch(r'([A-Z]+)([0-9]+)',name)
                if not match:return (0,0)
                column=0
                for char in match.group(1):column=column*26+ord(char)-64
                return int(match.group(2)),column
            for name in sorted(names,key=key):result.extend(native_paragraphs(item.getCellByName(name).Text))
        elif item.supportsService('com.sun.star.text.Paragraph'):result.append(item)
    return result

def paragraph(session,block_id):
    match=re.fullmatch(r'paragraph-([0-9]+)',block_id or '')
    if not match:fail('INVALID_TARGET','段落身份无效。')
    values=checked_native_paragraphs(session);index=int(match.group(1))
    if index>=len(values):fail('INVALID_TARGET','段落已变化。')
    return values[index]

def checked_native_paragraphs(session):
    values=native_paragraphs(session['doc'].Text)
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read('word/document.xml'));namespace='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';paragraphs=root.iter(namespace+'p');expected_text=[''.join(t.text or '' for t in p.iter(namespace+'t')) for p in paragraphs]
    if len(expected_text)!=len(values) or any(value.String!=text for value,text in zip(values,expected_text)):fail('NATIVE_TARGET_UNSUPPORTED','正文和镜像段落结构不一致，未猜测对象位置。')
    return values

def mapped_sheet(session,sheet_id):
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read('xl/workbook.xml'));items=root.findall('{*}sheets/{*}sheet');found=[v for v in items if v.attrib.get('sheetId')==str(sheet_id)]
        if len(found)!=1:fail('INVALID_TARGET','工作表身份已变化。')
        return sheet_by_name(session,found[0].attrib['name'])

def mapped_slide(session,slide_id):
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read('ppt/presentation.xml'));rels=ET.fromstring(archive.read('ppt/_rels/presentation.xml.rels'));targets={v.attrib['Id']:str(pathlib.PurePosixPath('ppt')/v.attrib['Target']).replace('ppt/../','') for v in rels};items=root.findall('{*}sldIdLst/{*}sldId');paths=[targets.get(v.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')) for v in items]
        if slide_id not in paths:fail('INVALID_TARGET','幻灯片身份已变化。')
        index=paths.index(slide_id);return session['doc'].getDrawPages().getByIndex(index),index

def mapped_shape(session,slide_id,shape_id):
    page,index=mapped_slide(session,slide_id)
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read(slide_id));found=[v for v in root.findall('.//{*}cNvPr') if v.attrib.get('id')==str(shape_id)]
        if len(found)!=1:fail('INVALID_TARGET','对象身份已变化。')
        name=found[0].attrib.get('name','');shapes=[page.getByIndex(i) for i in range(page.getCount()) if getattr(page.getByIndex(i),'Name','')==name]
        if len(shapes)!=1:fail('INVALID_TARGET','原生对象名称不唯一。')
        return page,shapes[0]

def text_style(target,op):
    for field,property_name in [('fontName','CharFontName'),('fontSize','CharHeight')]:
        if field in op:setattr(target,property_name,op[field])
    if 'bold' in op:target.CharWeight=150. if op['bold'] else 100.
    if 'italic' in op:target.CharPosture=uno.Enum('com.sun.star.awt.FontSlant','ITALIC' if op['italic'] else 'NONE')
    if 'underline' in op:target.CharUnderline=constant('com.sun.star.awt.FontUnderline.SINGLE',1) if op['underline'] else 0
    if 'strike' in op:target.CharStrikeout=constant('com.sun.star.awt.FontStrikeout.SINGLE',1) if op['strike'] else 0
    if 'color' in op:target.CharColor=int(op['color'],16)
    if 'highlight' in op:target.CharBackColor=int(op['highlight'],16)

def move_right(cursor,count,select):
    while count>0:
        amount=min(count,32767)
        if not cursor.goRight(amount,select):fail('INVALID_TARGET','原生文本范围已变化。')
        count-=amount

def utf16_index(text,index):
    total=0
    for i,char in enumerate(text):
        if total==index:return i
        total+=2 if ord(char)>0xffff else 1
        if total>index:fail('INVALID_TARGET','文字范围截断了 Unicode 字符。')
    if total==index:return len(text)
    fail('INVALID_TARGET','文字范围超出正文。')

def execute_operation(session,view,op,args=None):
    doc=session['doc'];kind=op['kind'];point=lambda value:round(value*2540/72)
    if kind.startswith('word.') or kind.startswith('office.'):
        target=paragraph(session,op.get('blockId')) if session['format']=='docx' and 'blockId' in op else mapped_shape(session,op['slideId'],op['blockId'])[1] if session['format']=='pptx' else None
        if kind in ['office.formatText','office.setTextStyle']:
            start=utf16_index(target.String,op['from']);end=utf16_index(target.String,op['to'])
            if target.String[start:end]!=op['expectedText']:fail('REVISION_CONFLICT','目标文字已变化。')
            cursor=target.Text.createTextCursorByRange(target.getStart());move_right(cursor,start,False);move_right(cursor,end-start,True)
            style=op if kind=='office.setTextStyle' else {op['style']:op['enabled']};text_style(cursor,style)
        elif kind=='word.setBlock':target.String=op['text']
        elif kind=='word.setParagraphFormat':
            if 'style' in op:target.ParaStyleName={'Normal':'Standard','Heading1':'Heading 1','Heading2':'Heading 2','Heading3':'Heading 3'}[op['style']]
            if 'alignment' in op:target.ParaAdjust=uno.Enum('com.sun.star.style.ParagraphAdjust',{'left':'LEFT','center':'CENTER','right':'RIGHT','both':'BLOCK'}[op['alignment']])
            for key,name in [('spacingBefore','ParaTopMargin'),('spacingAfter','ParaBottomMargin'),('indentLeft','ParaLeftMargin'),('indentRight','ParaRightMargin'),('indentFirstLine','ParaFirstLineIndent')]:
                if key in op:setattr(target,name,point(op[key]))
            if 'lineSpacing' in op:spacing=uno.createUnoStruct('com.sun.star.style.LineSpacing');spacing.Mode=constant('com.sun.star.style.LineSpacingMode.PROP',0);spacing.Height=round(op['lineSpacing']*100);target.ParaLineSpacing=spacing
        elif kind=='word.insertParagraph':
            target=paragraph(session,op['afterBlockId']);cursor=target.Text.createTextCursorByRange(target.getEnd());target.Text.insertControlCharacter(cursor,constant('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK',0),False);target.Text.insertString(cursor,op['text'],False);cursor.ParaStyleName={'Normal':'Standard','Heading1':'Heading 1','Heading2':'Heading 2','Heading3':'Heading 3'}[op.get('style','Normal')]
        elif kind=='word.deleteParagraph':
            cursor=target.Text.createTextCursorByRange(target.getStart());cursor.gotoRange(target.getEnd(),True);cursor.goRight(1,True);cursor.String=''
        elif kind=='word.insertTable':
            target=paragraph(session,op['afterBlockId']);table=doc.createInstance('com.sun.star.text.TextTable');table.initialize(len(op['rows']),len(op['rows'][0]));cursor=target.Text.createTextCursorByRange(target.getEnd());target.Text.insertControlCharacter(cursor,constant('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK',0),False);target.Text.insertTextContent(cursor,table,False)
            for r,row in enumerate(op['rows']):
                for c,text in enumerate(row):table.getCellByName(letter(c)+str(r+1)).String=text
        elif kind=='word.setPageLayout':
            if op.get('sectionIndex',0)!=0:fail('NATIVE_OPERATION_UNSUPPORTED','当前原生页设置需要具体页面样式目标。')
            if args and (args.get('background') or args.get('actor','agent')=='agent'):fail('BACKGROUND_EDIT_UNSUPPORTED','后台页面布局必须指定 pageStyleName，不读取人类光标所在页面样式。')
            style=doc.getStyleFamilies().getByName('PageStyles').getByName(view['controller'].getViewCursor().PageStyleName)
            if 'orientation' in op:
                landscape=op['orientation']=='landscape';style.IsLandscape=landscape
                if (style.Width>style.Height)!=landscape:width=style.Width;style.Width=style.Height;style.Height=width
            for side,value in op.get('margins',{}).items():setattr(style,side.capitalize()+'Margin',point(value))
        else:fail('NATIVE_OPERATION_UNSUPPORTED','此文字操作尚未映射到原生引擎。')
    elif kind.startswith('sheets.'):
        sheets=doc.getSheets();sheet=mapped_sheet(session,op['sheetId']) if 'sheetId' in op else None
        if kind=='sheets.setCell':
            cell=checked_range(sheet,op['address'])
            if op.get('formula') is not None:set_excel_formula(session,cell,op['formula'])
            elif op.get('valueType')=='number':cell.Value=float(op['value'])
            elif op.get('valueType')=='boolean':cell.Value=1. if op['value'].lower()=='true' else 0.;cell.NumberFormat=99
            else:cell.String=op['value']
        elif kind=='sheets.setRangeValues':
            start=checked_range(sheet,op['start']).getRangeAddress()
            for r,row in enumerate(op['rows']):
                for c,text in enumerate(row):
                    cell=sheet.getCellByPosition(start.StartColumn+c,start.StartRow+r)
                    if text.startswith('=') and len(text)>1:set_excel_formula(session,cell,text)
                    else:cell.String=text
        elif kind in ['sheets.setCellFormat','sheets.setRangeFormat']:
            target=checked_range(sheet,op.get('address',op.get('range')));text_style(target,op)
            if 'fill' in op:target.CellBackColor=int(op['fill'],16)
            if 'wrap' in op:target.IsTextWrapped=op['wrap']
            if 'horizontal' in op:target.HoriJustify=uno.Enum('com.sun.star.table.CellHoriJustify',op['horizontal'].upper())
            if 'vertical' in op:target.VertJustify=uno.Enum('com.sun.star.table.CellVertJustify',{'top':'TOP','middle':'CENTER','bottom':'BOTTOM'}[op['vertical']])
            if 'numberFormat' in op:
                locale=target.CharLocale;key=doc.NumberFormats.queryKey(op['numberFormat'],locale,True);target.NumberFormat=key if key>=0 else doc.NumberFormats.addNew(op['numberFormat'],locale)
            if 'borders' in op:
                border=uno.createUnoStruct('com.sun.star.table.TableBorder2');line=uno.createUnoStruct('com.sun.star.table.BorderLine2');line.Color=int(op.get('borderColor','808080'),16);line.LineWidth=point(1.5 if op.get('borderStyle')=='medium' else .75);line.LineStyle=constant('com.sun.star.table.BorderLineStyle.DASHED',3) if op.get('borderStyle')=='dashed' else constant('com.sun.star.table.BorderLineStyle.SOLID',0)
                for side in ['Top','Bottom','Left','Right','Horizontal','Vertical']:
                    enabled=op['borders']=='all' or op['borders']=='outline' and side in ['Top','Bottom','Left','Right'] or op['borders']=='bottom' and side=='Bottom';setattr(border,side+'Line',line if enabled else uno.createUnoStruct('com.sun.star.table.BorderLine2'));setattr(border,'Is'+side+'LineValid',True)
                target.TableBorder2=border
        elif kind in ['sheets.mergeCells','sheets.unmergeCells']:
            target=checked_range(sheet,op['range'])
            if kind=='sheets.mergeCells':
                values=target.getDataArray()
                if any(value!='' for r,row in enumerate(values) for c,value in enumerate(row) if r or c):fail('MERGE_WOULD_DISCARD_DATA','合并区域包含需要保留的非主单元格内容。')
            target.merge(kind=='sheets.mergeCells')
        elif kind in ['sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns']:
            collection=sheet.getRows() if 'Rows' in kind else sheet.getColumns();method=collection.insertByIndex if '.insert' in kind else collection.removeByIndex;method(op['index']-1,op.get('count',1))
        elif kind=='sheets.setColumnWidth':sheet.getColumns().getByIndex(op['index']-1).Width=round(op['width']*210)
        elif kind=='sheets.setRowHeight':sheet.getRows().getByIndex(op['index']-1).Height=point(op['height'])
        elif kind=='sheets.addWorksheet':sheets.insertNewByName(op['name'],sheets.getCount())
        elif kind=='sheets.renameWorksheet':sheet.Name=op['name']
        elif kind=='sheets.deleteWorksheet':
            if sheets.getCount()<=1:fail('INVALID_TARGET','工作簿必须保留至少一个工作表。')
            sheets.removeByName(sheet.Name)
        elif kind=='sheets.setFreeze':
            if args and (args.get('background') or args.get('actor','agent')=='agent'):fail('BACKGROUND_EDIT_UNSUPPORTED','冻结窗格依赖视图控制器，后台执行不会切换人类工作表。')
            view['controller'].setActiveSheet(sheet);view['controller'].freezeAtPosition(op['columns'],op['rows'])
        elif kind=='sheets.setAutoFilter':
            if not op.get('range'):fail('INVALID_TARGET','原生筛选需要明确区域。')
            target=checked_range(sheet,op['range']);name='AgentViewerFilter'+str(target.getRangeAddress().Sheet);ranges=doc.DatabaseRanges
            if ranges.hasByName(name):ranges.removeByName(name)
            if op['enabled']:ranges.addNewByName(name,target.getRangeAddress());ranges.getByName(name).AutoFilter=True
        elif kind=='sheets.sortRange':
            target=checked_range(sheet,op['range']);address=target.getRangeAddress();field=uno.createUnoStruct('com.sun.star.util.SortField');field.Field=op['column']-1-address.StartColumn;field.SortAscending=op['direction']=='asc';target.sort(props({'SortFields':(field,),'ContainsHeader':op['header'],'IsSortColumns':False}))
        else:fail('NATIVE_OPERATION_UNSUPPORTED','此工作表操作尚未映射到原生引擎。')
    elif kind.startswith('slides.'):
        pages=doc.getDrawPages();page,index=mapped_slide(session,op['slideId']) if 'slideId' in op else (None,-1)
        if kind=='slides.setText':ppt_set_shape_text(session,view,op,args or {})
        elif kind=='slides.setShapeStyle':apply_mapped_shape_style(session,view,op,args or {})
        elif kind=='slides.setShapeBounds':
            shape=mapped_shape(session,op['slideId'],op['shapeId'])[1]
            shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',round(op['x']*page.Width),round(op['y']*page.Height));shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',round(op['width']*page.Width),round(op['height']*page.Height))
        elif kind=='slides.addTextShape':
            shape=doc.createInstance('com.sun.star.drawing.TextShape');shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',round(op['x']*page.Width),round(op['y']*page.Height));shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',round(op['width']*page.Width),round(op['height']*page.Height));page.add(shape);shape.String=op['text']
        elif kind=='slides.deleteShape':page.remove(mapped_shape(session,op['slideId'],op['shapeId'])[1])
        elif kind=='slides.addSlide':
            after=mapped_slide(session,op['afterSlideId'])[1] if op.get('afterSlideId') else pages.getCount()-1;new=pages.insertNewByIndex(after)
            if op.get('title'):
                shape=doc.createInstance('com.sun.star.drawing.TextShape');shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',1000,1000);shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',new.Width-2000,3000);new.add(shape);shape.String=op['title']
        elif kind=='slides.deleteSlide':
            if pages.getCount()<=1:fail('INVALID_TARGET','演示文稿必须保留至少一页。')
            pages.remove(page)
        elif kind=='slides.duplicateSlide':doc.duplicate(page)
        elif kind=='slides.moveSlide':authoring_move_slide(session,view,index,op['index'])
        elif kind=='slides.setBackground':background=doc.createInstance('com.sun.star.drawing.Background');background.FillStyle=uno.Enum('com.sun.star.drawing.FillStyle','SOLID');background.FillColor=int(op['color'],16);page.Background=background
        elif kind=='slides.setNotes':
            notes=page.getNotesPage();found=[notes.getByIndex(i) for i in range(notes.getCount()) if notes.getByIndex(i).ShapeType=='com.sun.star.presentation.NotesShape']
            if len(found)!=1:fail('INVALID_TARGET','备注正文目标不唯一。')
            found[0].String=op['text']
        else:fail('NATIVE_OPERATION_UNSUPPORTED','此幻灯片操作需要原生命令参数。')
    else:fail('NATIVE_OPERATION_UNSUPPORTED','此操作不属于原生 Office。')

FILTERS={'docx':'Office Open XML Text','pptx':'Impress MS PowerPoint 2007 XML','xlsx':'Calc MS Excel 2007 XML','odt':'writer8','ods':'calc8','odp':'impress8'}

def snapshot_diagnostic(session,attempt,format,before,after,dirty_before,dirty_after,undo_before,undo_after):
    # Undo titles can contain user-entered content. Diagnostics retain hashes,
    # counts and state flags only, never titles, paths or document text.
    def version(revision,dirty,undo):return {'revision':revision,'dirty':bool(dirty),'undoToken':undo.get('token',''),'undoCount':undo.get('count',0),'canUndo':bool(undo.get('canUndo')),'canRedo':bool(undo.get('canRedo'))}
    return {'type':'diagnostic','code':'NATIVE_SNAPSHOT_UNSTABLE','sessionId':session.get('sessionId'),'format':session['format'],'exportFormat':format,'attempt':attempt+1,'before':version(before,dirty_before,undo_before),'after':version(after,dirty_after,undo_after),'changed':{'revision':before!=after,'dirty':dirty_before!=dirty_after,'undo':undo_before!=undo_after,'undoTitle':undo_before.get('title')!=undo_after.get('title')}}

def reconcile_clone_shape_colors(session,clone):
    source_pages=session['doc'].getDrawPages();clone_pages=clone.getDrawPages()
    if source_pages.getCount()!=clone_pages.getCount():fail('NATIVE_EXPORT_FAILED','隔离导出副本的页面结构不一致。')
    for page_index in range(source_pages.getCount()):
        source_page=source_pages.getByIndex(page_index);clone_page=clone_pages.getByIndex(page_index)
        if source_page.getCount()!=clone_page.getCount():fail('NATIVE_EXPORT_FAILED','隔离导出副本的对象结构不一致。')
        for index in range(source_page.getCount()):
            source=source_page.getByIndex(index);target=clone_page.getByIndex(index)
            if source.ShapeType!=target.ShapeType or getattr(source,'Name','')!=getattr(target,'Name','') or getattr(source,'String','')!=getattr(target,'String',''):fail('NATIVE_EXPORT_FAILED','隔离导出副本的实际对象身份不一致。')
            source_info=source.getPropertySetInfo();target_info=target.getPropertySetInfo();copied=False
            for color,complex_name in [('FillColor','FillComplexColor'),('LineColor','LineComplexColor')]:
                if not source_info.hasPropertyByName(color) or not source_info.hasPropertyByName(complex_name):continue
                if not target_info.hasPropertyByName(color) or not target_info.hasPropertyByName(complex_name):fail('NATIVE_EXPORT_FAILED','隔离导出副本缺少原生颜色属性。')
                rgb=source.getPropertyValue(color);complex_value=source.getPropertyValue(complex_name)
                # ODF may omit an Unused/Unknown complex color and inherit a
                # parent's theme in the temporary clone. Copy the immutable
                # native value only onto that verified clone; never the source.
                # The public interface cannot enumerate hidden transforms;
                # always copy the complete immutable native carrier. A theme
                # setter may resolve its cached RGB, so restore RGB last.
                target.setPropertyValue(complex_name,uno.Any('com.sun.star.util.XComplexColor',complex_value));target.setPropertyValue(color,uno.Any('long',rgb));copied=True
                actual=target.getPropertyValue(complex_name)
                if rgb!=target.getPropertyValue(color) or (complex_value.getType(),complex_value.getThemeColorType())!=(actual.getType(),actual.getThemeColorType()):fail('NATIVE_EXPORT_FAILED','隔离导出副本的颜色恢复未通过验证。')
            if copied:
                if source_info.hasPropertyByName('InteropGrabBag'):
                    if not target_info.hasPropertyByName('InteropGrabBag'):fail('NATIVE_EXPORT_FAILED','隔离导出副本缺少颜色互操作属性。')
                    bag=source.getPropertyValue('InteropGrabBag');target.setPropertyValue('InteropGrabBag',uno.Any('[]com.sun.star.beans.PropertyValue',bag))
                    if style_value_key(bag)!=style_value_key(target.getPropertyValue('InteropGrabBag')):fail('NATIVE_EXPORT_FAILED','隔离导出副本的互操作属性恢复未通过验证。')

def store_snapshot_file(session,output,filter_name):
    # PPTX's exporter creates and removes temporary layout slides in the live
    # model. Those implementation details must not become user undo actions.
    # XUndoManager.lock alone does not stop the native Impress exporter's own
    # Sdr undo records. Copy the live model into a disposable native ODF
    # storage, then let a viewless read-only clone bear temporary layout changes.
    # Suspend registered inputs only during the short live-model serialization.
    guarded=filter_name=='Impress MS PowerPoint 2007 XML';windows=[];manager=None;locked=False;intermediate=None;clone=None
    try:
        try:
            if guarded:
                for candidate in session['views'].values():
                    if candidate.get('disposed'):continue
                    window=candidate['frame'].getContainerWindow()
                    if not window.isEnabled():fail('NATIVE_PENDING_INPUT','原生对话框或输入操作尚未结束，没有冻结其内容。')
                    windows.append(window);window.setEnable(False)
                manager=session['doc'].getUndoManager()
                if manager.isLocked():fail('NATIVE_UNDO_BUSY','原生撤销事务尚未结束，没有改变其记录。')
                manager.lock();locked=True
            serialization_started=time.monotonic()
            # XStorage is a complete native ODF package, not a partial model.
            # Reuse its open package instead of exporting/reopening an ODP URL.
            # The factory may spool to native temporary files; no Python byte
            # buffers or cross-snapshot cache are retained. Keep the thumbnail
            # path: toggling NoThumbnail mutates the pinned source model.
            options={'FilterName':'impress8' if guarded else filter_name,'Overwrite':True}
            if guarded:
                base_url=session['doc'].getURL();options['DocumentBaseURL']=base_url
                intermediate=sm.createInstanceWithContext('com.sun.star.embed.StorageFactory',ctx).createInstance()
                session['doc'].storeToStorage(intermediate,props(options))
            else:session['doc'].storeToURL(output.as_uri(),props(options))
            if guarded:emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'serialize-intermediate','elapsedMs':round((time.monotonic()-serialization_started)*1000,2)})
        finally:
            try:
                if locked:manager.unlock()
            finally:
                restore_failed=False
                for window in reversed(windows):
                    try:window.setEnable(True)
                    except:restore_failed=True
                if restore_failed:fail('NATIVE_INPUT_RESTORE_FAILED','原生视图输入未恢复，请保留文档并重新打开该视图。')
        if intermediate is not None:
            clone_started=time.monotonic()
            clone=sm.createInstanceWithContext('com.sun.star.presentation.PresentationDocument',ctx)
            clone_created=time.monotonic()
            if clone is not None:clone.loadFromStorage(intermediate,props({'DocumentBaseURL':base_url,'Hidden':True,'ReadOnly':True,'FilterName':'impress8','MacroExecutionMode':uno.Any('short',0),'UpdateDocMode':uno.Any('short',0),'InteractionHandler':SafeImportInteraction()}))
            emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'load-readonly-clone','elapsedMs':round((time.monotonic()-clone_started)*1000,2),'createModelMs':round((clone_created-clone_started)*1000,2),'importMs':round((time.monotonic()-clone_created)*1000,2)})
            if clone is None:fail('NATIVE_EXPORT_FAILED','无法创建隔离的只读导出副本。')
            if not clone.isReadonly() or clone.getCurrentController() is not None:fail('NATIVE_EXPORT_FAILED','隔离导出副本没有保持无视图只读模型。')
            reconcile_started=time.monotonic()
            reconcile_clone_shape_colors(session,clone)
            emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'reconcile-colors','elapsedMs':round((time.monotonic()-reconcile_started)*1000,2)})
            export_started=time.monotonic()
            clone.storeToURL(output.as_uri(),props({'FilterName':filter_name,'Overwrite':True}))
            emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'export-pptx','elapsedMs':round((time.monotonic()-export_started)*1000,2)})
    finally:
        try:
            if clone is not None:clone.close(True)
        finally:
            if intermediate is not None:
                intermediate.dispose()

def snapshot(session,view,export_format=None,known=None):
    def response(result,data):
        # The host lends its verified mirror, never a second resident cache.
        # Native state, undo and every controller's input barrier are still
        # checked before this branch. Only the wire payload is omitted.
        if not export_format and isinstance(known,dict) and type(known.get('engineRevision')) is int and isinstance(known.get('sha256'),str) and len(known['sha256'])==64 and known.get('engineEpoch')==epoch and known.get('engineRevision')==result.get('engineRevisionAfter')==result['state'].get('engineRevision') and known.get('sha256')==result.get('sha256'):
            return dict(result,unchanged=True)
        return dict(result,bytes=base64.b64encode(data).decode())
    for candidate in session['views'].values():
        if not candidate.get('disposed') and snapshot_input_pending(session,candidate):fail('NATIVE_PENDING_INPUT','此文档的原生视图仍有未完成输入，没有自动提交。')
    cached=session.get('lastSnapshot');current_undo=undo_state(session)
    # An explicit native-format copy may use the same verified immutable bytes,
    # but never a cross-format or legacy cache without a declared format/raw body.
    same_format_copy=export_format==session['format'] and cached and isinstance(cached.get('result'),dict) and cached['result'].get('format')==export_format and isinstance(cached.get('data'),bytes)
    if (export_format is None or same_format_copy) and cached and cached.get('result') and cached['engineRevision']==session['engineRevision'] and cached.get('undoToken')==current_undo.get('token') and cached.get('dirty')==session['doc'].isModified():
        # ZIP metadata is not a content clock. Reuse already-verified same-version bytes,
        # refreshing view state while preserving the all-controller input barrier.
        result=dict(cached['result']);result['state']=state(session,view);result['dirty']=session['doc'].isModified()
        return response(result,cached['data']) if 'data' in cached else result
    format=export_format or session['format'];filter_name=FILTERS.get(format) or {'docx':'writer_pdf_Export','xlsx':'calc_pdf_Export','pptx':'impress_pdf_Export'}.get(session['format']) if format=='pdf' else FILTERS.get(format)
    if not filter_name:fail('NATIVE_EXPORT_UNSUPPORTED','此导出格式尚未接入。')
    family={'docx':{'docx','odt','pdf'},'xlsx':{'xlsx','ods','pdf'},'pptx':{'pptx','odp','pdf'}}
    if format not in family[session['format']]:fail('NATIVE_EXPORT_UNSUPPORTED','此格式不属于当前文档类别。')
    for attempt in range(3):
        before=session['engineRevision'];undo_before=undo_state(session);dirty=session['doc'].isModified();output=ROOT/(str(uuid.uuid4())+'.'+format)
        try:
            session['exporting']=True;store_snapshot_file(session,output,filter_name);data=output.read_bytes()
        finally:
            session['exporting']=False
            try:output.unlink()
            except:pass
        after=session['engineRevision'];undo_after=undo_state(session);dirty_after=session['doc'].isModified()
        if before==after and undo_before==undo_after and dirty_after==dirty:
            digest=hashlib.sha256(data).hexdigest()
            result={'sha256':digest,'format':format,'engineRevisionBefore':before,'engineRevisionAfter':after,'stable':True,'dirty':dirty,'undoToken':undo_after.get('token'),'state':state(session,view)}
            if not export_format:session['lastSnapshot']={'engineRevision':after,'hash':digest,'undoToken':result['undoToken'],'dirty':dirty,'result':result,'data':data};session['mappingBytes']=data
            return response(result,data)
        emit(snapshot_diagnostic(session,attempt,format,before,after,dirty,dirty_after,undo_before,undo_after))
    fail('SNAPSHOT_BUSY','原生文档仍在修改，未发布混合版本快照。')

def acknowledge_saved(session,args):
    refresh_content_dirtiness(session)
    saved=session.get('lastSnapshot');before=session['engineRevision'];before_undo=undo_state(session)
    if not (args.get('engineEpoch')==epoch and saved and saved['engineRevision']==before==args.get('engineRevision') and saved['hash']==args.get('hash') and saved.get('undoToken')==before_undo.get('token')):return False
    acknowledgement={'engineRevision':before,'undo':before_undo};session['acknowledgingSave']=acknowledgement;failed=False
    try:session['doc'].setModified(False)
    except:failed=True
    finally:
        if session.get('acknowledgingSave') is acknowledgement:session.pop('acknowledgingSave',None)
    if failed or session['engineRevision']!=before or undo_state(session)!=before_undo or session['doc'].isModified():
        session['unsavedContentChanges']=True
        session.pop('lastSnapshot',None)
        # A concurrent edit must not be cleared by the preceding status reset.
        if not session['doc'].isModified():session['doc'].setModified(True)
        return False
    session['unsavedContentChanges']=False;saved['dirty']=False
    if saved.get('result'):saved['result']={**saved['result'],'dirty':False,'state':{**saved['result'].get('state',{}),'dirty':False,'unsavedContentChanges':False}}
    return True

def commands(session,view):
    if session.get('commandCatalog') is not None:return session['commandCatalog']
    found={}
    for provider in [view['controller'],view['frame']]:
        try:
            for group in provider.getSupportedCommandGroups():
                for item in provider.getConfigurableDispatchInformation(group):found[item.Command]={'command':item.Command,'group':int(item.GroupId)}
        except:pass
    def parse_items(container):
        for index in range(container.getCount()):
            values={v.Name:v.Value for v in container.getByIndex(index)};command=values.get('CommandURL')
            if command and command.startswith('.uno:'):found.setdefault(command,{'command':command,'label':values.get('Label','')})
            child=values.get('ItemDescriptorContainer')
            if child is not None:parse_items(child)
    try:
        supplier=sm.createInstanceWithContext('com.sun.star.ui.ModuleUIConfigurationManagerSupplier',ctx);module=session['doc'].getIdentifier();config=supplier.getUIConfigurationManager(module);parse_items(config.getSettings('private:resource/menubar/menubar',True))
    except:pass
    result={'commands':list(found.values()),'source':'LibreOffice configurable dispatch/menu configuration','complete':bool(found)}
    if found:session['commandCatalog']=result
    return result
`;
