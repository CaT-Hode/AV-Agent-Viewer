import { officeAuthoringCapabilityManifest, officeAuthoringRequiresDocCall } from './authoring';

/** Revision-bound model operations. No controller selection, focus or page changes. */
export const officeAuthoringSource = String.raw`
authoring_capability_manifest=json.loads(${JSON.stringify(JSON.stringify(officeAuthoringCapabilityManifest))})
authoring_requires_doc_call=json.loads(${JSON.stringify(JSON.stringify(officeAuthoringRequiresDocCall))})
def authoring_format(session,kind):
    wanted={'word':'docx','sheets':'xlsx','slides':'pptx'}.get(kind.split('.')[0])
    if wanted and session['format']!=wanted:fail('NATIVE_OPERATION_UNSUPPORTED','操作与当前 Office 文档类型不匹配。')

def authoring_enum(value):return getattr(value,'value',value)

def authoring_index(collection,index):
    if type(index) is not int or index<0 or index>=collection.getCount():fail('INVALID_TARGET','原生目标索引已变化。')
    return collection.getByIndex(index)

def authoring_paragraphs(text):
    enumeration=text.createEnumeration()
    while enumeration.hasMoreElements():
        item=enumeration.nextElement()
        if item.supportsService('com.sun.star.text.TextTable'):
            for name in item.getCellNames():yield from authoring_paragraphs(item.getCellByName(name).Text)
        elif item.supportsService('com.sun.star.text.Paragraph'):yield item

def authoring_paragraph(session,index):
    for position,value in enumerate(authoring_paragraphs(session['doc'].Text)):
        if position==index:return value
    fail('INVALID_TARGET','原生段落已变化。')

def authoring_text_range(session,op):
    paragraph=authoring_paragraph(session,op['paragraphIndex']);text=paragraph.String
    start=utf16_index(text,op['from']);end=utf16_index(text,op['to'])
    if start>end or text[start:end]!=op['expectedText']:fail('REVISION_CONFLICT','目标文字已变化。')
    cursor=paragraph.Text.createTextCursorByRange(paragraph.getStart())
    move_right(cursor,start,False);move_right(cursor,end-start,True)
    if cursor.String!=op['expectedText']:fail('REVISION_CONFLICT','原生文字范围无法对应 Unicode 边界。')
    return paragraph,cursor

def authoring_shape(session,target):
    page=authoring_index(session['doc'].getDrawPages(),target['slideIndex']);container=page;shape=None
    for index in target['objectPath']:
        shape=authoring_index(container,index);container=shape
    return page,shape

def authoring_retained_word_range(session,anchor,expected_text=None):
    item=session.setdefault('authoringRanges',{}).get(anchor)
    if item is None or item['revision']!=session['engineRevision']:fail('REVISION_CONFLICT','原生保留范围已过期，请重新读取选区。')
    cursor=item['range'];text=cursor.String
    if native_text_container_id(session,cursor.Text)!=item['containerId'] or len(text.encode('utf-16-le'))//2>100000:fail('INVALID_TARGET','原生保留范围的容器或长度已变化。')
    if expected_text is not None and text!=expected_text:fail('REVISION_CONFLICT','原生保留范围的文字已变化。')
    return item,cursor

def authoring_read_boundary(text,index,round_up=False):
    total=0
    for position,char in enumerate(text):
        width=2 if ord(char)>0xffff else 1
        if index==total:return position,total
        if index<total+width:return (position+1,total+width) if round_up else (position,total)
        total+=width
    return len(text),total

def authoring_word_target(session,view,actual):
    text=actual.Text;content=actual.String
    if len(content.encode('utf-16-le'))//2>100000:fail('NATIVE_QUERY_LIMIT','单次原生文字范围最多十万个 UTF-16 单元。')
    # Compare native ranges before reading paragraph strings. Equal text in a
    # different paragraph/table cell can never identify the editing target.
    try:direction=text.compareRegionStarts(text.getStart(),text.getEnd())
    except:direction=0
    if direction:
        for index,paragraph in enumerate(authoring_paragraphs(session['doc'].Text)):
            if paragraph.Text!=text:continue
            try:
                if text.compareRegionStarts(paragraph.getStart(),actual.getStart())*direction<0:break
                if text.compareRegionStarts(actual.getEnd(),paragraph.getEnd())*direction<0:continue
                prefix=text.createTextCursorByRange(paragraph.getStart());prefix.gotoRange(actual.getStart(),True);start=len(prefix.String.encode('utf-16-le'))//2;end=start+len(content.encode('utf-16-le'))//2
                value=paragraph.String
                if value[utf16_index(value,start):utf16_index(value,end)]==content:return {'kind':'word.range','paragraphIndex':index,'from':start,'to':end}
            except RuntimeError:raise
            except:continue
    locator=native_range_locator(session,view,actual,content);ranges=session.setdefault('authoringRanges',{});identity=locator['blockId']
    for anchor,item in ranges.items():
        if item['revision']!=session['engineRevision'] or item['containerId']!=identity:continue
        try:
            if text.compareRegionStarts(actual,item['range'])==0 and text.compareRegionEnds(actual,item['range'])==0:return {'kind':'word.nativeRange','anchor':anchor,'containerId':identity,'from':locator['from'],'to':locator['to']}
        except:pass
    cursor=text.createTextCursorByRange(actual.getStart());cursor.gotoRange(actual.getEnd(),True);anchor=str(uuid.uuid4())
    for key in [key for key,item in ranges.items() if item['revision']!=session['engineRevision']]:ranges.pop(key,None)
    while len(ranges)>=128:ranges.pop(next(iter(ranges)))
    ranges[anchor]={'revision':session['engineRevision'],'containerId':identity,'range':cursor,'from':locator['from'],'to':locator['to']}
    return {'kind':'word.nativeRange','anchor':anchor,'containerId':identity,'from':locator['from'],'to':locator['to']}

def authoring_word_replace(session,view,cursor,replacement):
    replacement=replacement.replace('\r\n','\n').replace('\r','\n')
    text=cursor.Text;prefix=text.createTextCursorByRange(cursor.getStart());prefix.goLeft(64,True);suffix=text.createTextCursorByRange(cursor.getEnd());suffix.goRight(64,True)
    before=prefix.String;after=suffix.String
    # Writer setString uses CR for a paragraph break and LF for a soft line
    # break. The authoring API uses normal LF text and creates real paragraphs.
    cursor.String=replacement.replace('\n','\r')
    prefix=text.createTextCursorByRange(cursor.getStart());prefix.goLeft(64,True);suffix=text.createTextCursorByRange(cursor.getEnd());suffix.goRight(64,True)
    if cursor.String.replace('\r\n','\n').replace('\r','\n')!=replacement or prefix.String!=before or suffix.String!=after:fail('NATIVE_READBACK_FAILED','原生文字范围及未选中边界的回读不一致。')
    return {'text':cursor.String,'target':authoring_word_target(session,view,cursor)}

def authoring_selection_target(session,view):
    selected=selection(session,view);text=selected.get('text','');result={'editable':False,'text':text};target=None
    if session['format']=='xlsx' and selected.get('kind')=='cells':target={'kind':'sheets.range','sheetName':selected['sheetName'],'range':selected['range']}
    elif session['format']=='docx':
        actual=selected_text_range(session,view)
        if actual is not None:target=authoring_word_target(session,view,actual);text=actual.String
    elif session['format']=='pptx':
        actual=selected_text_range(session,view);shape=None;native_text=None
        if actual is not None:native_text=actual.Text
        elif selected.get('kind')=='objects':
            objects=view['controller'].getSelection()
            if objects.getCount()==1:shape=objects.getByIndex(0)
        page=view['controller'].getCurrentPage();pages=session['doc'].getDrawPages();slide=next((index for index in range(pages.getCount()) if pages.getByIndex(index)==page),None);matches=[];visited=0
        def visit(container,path,depth):
            nonlocal visited
            if depth>16:return
            for index in range(container.getCount()):
                visited+=1
                if visited>4096:fail('NATIVE_QUERY_LIMIT','当前幻灯片对象超过精确选区查询范围。')
                item=container.getByIndex(index);current=path+[index]
                try:
                    if item==shape or native_text is not None and item.getText()==native_text:matches.append((current,item))
                except:pass
                if item.supportsService('com.sun.star.drawing.GroupShape'):visit(item,current,depth+1)
        if slide is not None and (shape is not None or native_text is not None):visit(page,[],0)
        if len(matches)==1:
            path,shape=matches[0]
            try:full=shape.getText().getString()
            except:full=None
            if full is not None and len(full.encode('utf-16-le'))//2<=100000:
                if actual is not None:
                    native=actual.getPropertyValue('Selection');positions=[native.Start.Paragraph,native.Start.PositionInParagraph,native.End.Paragraph,native.End.PositionInParagraph];prefix,content,suffix=ppt_text_parts(full,positions)
                    if content!=actual.String.replace('\r\n','\n').replace('\r','\n'):fail('SELECTION_CHANGED','真实 PPT 文字范围与对象内容不一致。')
                    start=len(prefix.encode('utf-16-le'))//2;end=start+len(content.encode('utf-16-le'))//2;text=actual.String
                else:start=0;end=len(full.encode('utf-16-le'))//2;text=full
                target={'kind':'slides.object','slideIndex':slide,'objectPath':path,'matchFrom':start,'matchTo':end}
    result['text']=text
    if target is None:return {**result,'code':'NATIVE_SELECTION_UNSUPPORTED','reason':'当前选区没有可唯一绑定的原生编辑目标。'}
    result['target']=target
    for candidate in session['views'].values():
        if candidate.get('disposed'):continue
        if own_ime_pending(candidate) or session['format'] in ['xlsx','pptx'] and (candidate.get('nativeEditing') or candidate.get('caretVisible')):return {**result,'code':'NATIVE_PENDING_INPUT','reason':'原生视图仍在输入或 Outliner 编辑，后台事务不会结束人类输入。'}
        if not candidate['frame'].getContainerWindow().isEnabled():return {**result,'code':'NATIVE_PENDING_INPUT','reason':'原生模态对话框尚未关闭。'}
    if target['kind']=='slides.object' and (len(target['objectPath'])!=1 or globals().get('doc_call') is None):return {**result,'code':'BACKGROUND_EDIT_UNSUPPORTED','reason':'当前后端没有该对象的独立后台文字事务。'}
    return {**result,'editable':True}

def authoring_shapes(page):
    values=[];truncated=False
    def visit(container,path,depth):
        nonlocal truncated
        if depth>16:truncated=True;return
        for index in range(container.getCount()):
            if len(values)>=500:truncated=True;return
            shape=container.getByIndex(index);position=shape.getPosition();size=shape.getSize();text=getattr(shape,'String','')
            item={'objectPath':path+[index],'name':getattr(shape,'Name',''),'type':shape.ShapeType,'text':text[:2000],'textTruncated':len(text)>2000,'bounds':{'x':position.X/100.,'y':position.Y/100.,'width':size.Width/100.,'height':size.Height/100.}}
            values.append(item)
            if shape.supportsService('com.sun.star.drawing.GroupShape'):visit(shape,path+[index],depth+1)
    visit(page,[],0)
    return {'objects':values,'truncated':truncated,'unit':'mm'}

def authoring_comments(doc):
    fields=doc.getTextFields().createEnumeration();items=[]
    while fields.hasMoreElements():
        field=fields.nextElement()
        if field.supportsService('com.sun.star.text.textfield.Annotation'):items.append(field)
        if len(items)>1000:fail('NATIVE_QUERY_LIMIT','批注数量超过单次查询限制。')
    return items

def authoring_redlines(session):
    if globals().get('doc_call') is None or session['doc'].getRedlines().getCount()>500:return None
    try:
        value=json.loads(kit_string(doc_call(session,'getCommandValues',P,S)(b'.uno:AcceptTrackedChanges')))
        items=value.get('redlines')
        if not isinstance(items,list) or len(items)!=session['doc'].getRedlines().getCount() or any(type(item.get('index')) is not int or item['index']<0 or item['index']>0xffffffff for item in items):return None
        return items
    except:return None

def authoring_inspect_style(session,kind,targets,fields):
    bindings=[style_binding(value,kind,fields,True) for value in targets];result={}
    for field in fields:
        samples=[sample for binding in bindings for sample in style_field_samples(session,binding,kind,field)]
        if not samples:fail('NATIVE_STYLE_FIELD_UNSUPPORTED','目标样式没有可验证的原生值。')
        mixed=any(state=='mixed' for value,state in samples) or any(value!=samples[0][0] for value,state in samples[1:])
        result[field]={'value':None if mixed else samples[0][0],'state':'mixed' if mixed else samples[0][1]}
    return result

def authoring_text_units(session,start=0):
    doc=session['doc']
    if session['format']=='docx':
        for index,paragraph in enumerate(authoring_paragraphs(doc.Text)):
            if index>=start:yield index,{'paragraphIndex':index},paragraph.String
    elif session['format']=='xlsx':
        sheets=doc.getSheets();base=0
        for index in range(sheets.getCount()):
            sheet=sheets.getByIndex(index);cursor=sheet.createCursor();cursor.gotoEndOfUsedArea(False);bounds=cursor.getRangeAddress()
            width=bounds.EndColumn+1;total=width*(bounds.EndRow+1)
            if start>=base+total:base+=total;continue
            first=max(0,start-base)
            for row in range(first//width,bounds.EndRow+1):
                for column in range(first%width if row==first//width else 0,width):yield base+row*width+column,{'sheetName':sheet.Name,'range':letter(column)+str(row+1)},sheet.getCellByPosition(column,row).String
            base+=total
    else:
        pages=doc.getDrawPages();position=0
        def shapes(container,path,depth):
            if depth>16:return
            for index in range(container.getCount()):
                shape=container.getByIndex(index);current=path+[index]
                if shape.supportsService('com.sun.star.drawing.GroupShape'):yield from shapes(shape,current,depth+1)
                else:yield current,shape
        for index in range(pages.getCount()):
            for path,shape in shapes(pages.getByIndex(index),[],0):
                if position>=start:yield position,{'slideIndex':index,'objectPath':path},getattr(shape,'String','')
                position+=1

def authoring_query(session,view,target):
    kind=target['kind'];doc=session['doc'];authoring_format(session,kind)
    if kind=='selection-target':return authoring_selection_target(session,view)
    if kind=='search':
        query=target['query'];start=target.get('start',0);offset=target.get('offset',0);limit=target.get('limit',30);units=[];scanned=0
        for index,location,text in authoring_text_units(session,start):
            if scanned>=2000:return {'units':units,'cursor':{'start':index,'offset':0},'engineRevision':session['engineRevision'],'coverage':'native-text'}
            scanned+=1;position=offset if index==start else 0
            if position>len(text):fail('INVALID_TARGET','搜索游标超出原生文字单元。')
            while True:
                found=text.find(query,position)
                if found<0:break
                end=found+len(query);units.append({**location,'from':len(text[:found].encode('utf-16-le'))//2,'to':len(text[:end].encode('utf-16-le'))//2,'text':query,'snippet':text[max(0,found-80):min(len(text),end+80)]})
                position=end
                if len(units)>=limit:return {'units':units,'cursor':{'start':index,'offset':position},'engineRevision':session['engineRevision'],'coverage':'native-text'}
        return {'units':units,'cursor':None,'engineRevision':session['engineRevision'],'coverage':'native-text'}
    if kind=='capabilities':
        capability=authoring_capability_manifest[session['format']]
        return {**capability,'operations':[name for name in capability['operations'] if globals().get('doc_call') is not None or name not in authoring_requires_doc_call]}
    if kind=='word.paragraphs':
        start=target.get('start',0);limit=target.get('limit',30);items=[];more=False
        for index,value in enumerate(authoring_paragraphs(doc.Text)):
            if index<start:continue
            if len(items)>=limit:more=True;break
            text=value.String;items.append({'paragraphIndex':index,'text':text[:10000],'textHash':hashlib.sha256(text.encode('utf-8')).hexdigest(),'textTruncated':len(text)>10000,'utf16Length':len(text.encode('utf-16-le'))//2,'style':getattr(value,'ParaStyleName','')})
        return {'paragraphs':items,'next':start+len(items) if more else None}
    if kind=='word.range':
        paragraph=authoring_paragraph(session,target['paragraphIndex']);text=paragraph.String
        if target['to']<target['from'] or target['to']-target['from']>100000:fail('NATIVE_QUERY_LIMIT','单次原生文字读取最多十万个 UTF-16 单元。')
        start,actual_from=authoring_read_boundary(text,target['from']);end,actual_to=authoring_read_boundary(text,target['to'],True)
        return {'paragraphIndex':target['paragraphIndex'],'from':actual_from,'to':actual_to,'text':text[start:end],'utf16Length':len(text.encode('utf-16-le'))//2}
    if kind=='word.nativeRange':
        item,cursor=authoring_retained_word_range(session,target['anchor']);return {'target':{'kind':'word.nativeRange','anchor':target['anchor'],'containerId':item['containerId'],'from':item['from'],'to':item['to']},'text':cursor.String}
    if kind=='word.pageStyles':
        styles=doc.getStyleFamilies().getByName('PageStyles');items=[]
        for name in styles.getElementNames():
            style=styles.getByName(name);items.append({'name':name,'landscape':bool(style.IsLandscape),'width':style.Width/100.,'height':style.Height/100.,**{side:getattr(style,side.capitalize()+'Margin')/100. for side in ['left','right','top','bottom']}})
        return {'styles':items,'unit':'mm'}
    if kind=='word.comments':
        return {'comments':[{'commentIndex':index,'text':field.Content,'author':field.Author,'anchorText':field.getAnchor().String[:2000]} for index,field in enumerate(authoring_comments(doc))]}
    if kind=='word.revisions':
        items=[];redlines=doc.getRedlines();native=authoring_redlines(session)
        for index in range(min(redlines.getCount(),500)):
            redline=redlines.getByIndex(index);item={'revisionIndex':index}
            for name,key in [('RedlineType','type'),('RedlineAuthor','author'),('RedlineComment','comment')]:
                try:item[key]=redline.getPropertyValue(name)
                except:pass
            items.append(item)
        return {'tracking':bool(doc.RecordChanges),'revisions':items,'total':redlines.getCount(),'truncated':redlines.getCount()>500,'canAcceptReject':native is not None}
    if kind=='word.tables':
        tables=doc.getTextTables();return {'tables':[{'name':name,'cells':len(tables.getByName(name).getCellNames())} for name in tables.getElementNames()]}
    if kind=='word.table':
        tables=doc.getTextTables()
        if not tables.hasByName(target['tableName']):fail('INVALID_TARGET','原生表格名称不存在。')
        table=tables.getByName(target['tableName']);names=table.getCellNames();start=target.get('start',0);limit=target.get('limit',30);wanted=target.get('cellName')
        if wanted is not None:
            if wanted not in names:fail('INVALID_TARGET','原生表格单元格名称不存在。')
            text=table.getCellByName(wanted).String
            if len(text.encode('utf-16-le'))//2>100000:fail('NATIVE_QUERY_LIMIT','表格单格正文超过十万个 UTF-16 单元。')
            return {'name':target['tableName'],'cells':[{'name':wanted,'text':text,'textTruncated':False}],'next':None,'total':len(names)}
        items=[]
        for name in names[start:start+limit]:
            text=table.getCellByName(name).String;items.append({'name':name,'text':text[:2000],'textTruncated':len(text)>2000,'utf16Length':len(text.encode('utf-16-le'))//2})
        return {'name':target['tableName'],'cells':items,'next':start+len(items) if start+len(items)<len(names) else None,'total':len(names)}
    if kind=='sheets.range':
        cells=checked_range(sheet_by_name(session,target['sheetName']),target['range']);return {'sheetName':target['sheetName'],'range':target['range'],**query_cell_range(session,cells)}
    if kind=='sheets.validation':
        value=checked_range(sheet_by_name(session,target['sheetName']),target['range']).Validation
        return {'sheetName':target['sheetName'],'range':target['range'],'type':authoring_enum(value.Type),'operator':authoring_enum(value.Operator),'formula1':value.getFormula1(),'formula2':value.getFormula2(),'allowEmpty':bool(value.IgnoreBlankCells),'showError':bool(value.ShowErrorMessage),'errorTitle':value.ErrorTitle,'errorMessage':value.ErrorMessage}
    if kind=='sheets.charts':
        charts=sheet_by_name(session,target['sheetName']).getCharts();items=[]
        for name in charts.getElementNames():
            chart=charts.getByName(name);diagram=chart.getEmbeddedObject().getDiagram();service=diagram.getDiagramType();types={'com.sun.star.chart.LineDiagram':'line','com.sun.star.chart.PieDiagram':'pie','com.sun.star.chart.XYDiagram':'scatter','com.sun.star.chart.AreaDiagram':'area'}
            chart_type=('bar' if bool(diagram.Vertical) else 'column') if service=='com.sun.star.chart.BarDiagram' else types.get(service,'unsupported')
            items.append({'name':name,'type':chart_type,'ranges':[{'sheetIndex':value.Sheet,'range':range_name(value)} for value in chart.getRanges()],'columnHeaders':bool(chart.getHasColumnHeaders()),'rowHeaders':bool(chart.getHasRowHeaders())})
        return {'charts':items}
    if kind=='sheets.pivots':
        tables=sheet_by_name(session,target['sheetName']).getDataPilotTables();items=[]
        for name in tables.getElementNames():
            table=tables.getByName(name);fields=table.getDataPilotFields();values=[]
            for index in range(fields.getCount()):
                field=fields.getByIndex(index);orientation=authoring_enum(field.Orientation)
                if orientation!='HIDDEN':values.append({'name':field.Name,'orientation':orientation,'function':authoring_enum(field.Function)})
            items.append({'name':name,'sourceRange':range_name(table.getSourceRange()),'outputRange':range_name(table.getOutputRange()),'fields':values})
        return {'pivots':items}
    if kind=='slides.objects':return {'slideIndex':target['slideIndex'],**authoring_shapes(authoring_index(doc.getDrawPages(),target['slideIndex']))}
    if kind=='slides.pages':
        pages=doc.getDrawPages();return {'slides':[{'slideIndex':index,'name':pages.getByIndex(index).Name,'width':pages.getByIndex(index).Width/100.,'height':pages.getByIndex(index).Height/100.} for index in range(pages.getCount())],'unit':'mm'}
    if kind=='slides.notes':
        page=authoring_index(doc.getDrawPages(),target['slideIndex']);notes=page.getNotesPage();found=[notes.getByIndex(index) for index in range(notes.getCount()) if notes.getByIndex(index).ShapeType=='com.sun.star.presentation.NotesShape']
        if len(found)!=1:fail('INVALID_TARGET','原生备注正文不唯一。')
        text=found[0].String
        if len(text.encode('utf-16-le'))//2>100000:fail('NATIVE_QUERY_LIMIT','备注正文超过单次读取范围。')
        return {'slideIndex':target['slideIndex'],'text':text}
    if kind=='slides.objectText':
        page,shape=authoring_shape(session,target);text=shape.getText().getString()
        if len(text.encode('utf-16-le'))//2>100000:fail('NATIVE_QUERY_LIMIT','对象文字超过十万个 UTF-16 单元，请分段读取。')
        return {'slideIndex':target['slideIndex'],'objectPath':target['objectPath'],'text':text,'utf16Length':len(text.encode('utf-16-le'))//2}
    if kind=='slides.masters':
        masters=doc.getMasterPages();return {'masters':[{'masterIndex':index,'name':masters.getByIndex(index).Name,'width':masters.getByIndex(index).Width/100.,'height':masters.getByIndex(index).Height/100.} for index in range(masters.getCount())],'unit':'mm'}
    if kind=='slides.animations':
        page=authoring_index(doc.getDrawPages(),target['slideIndex']);objects=authoring_shapes(page);items=[]
        for item in objects['objects']:
            shape=authoring_shape(session,{'slideIndex':target['slideIndex'],'objectPath':item['objectPath']})[1];fields={};info=shape.getPropertySetInfo()
            for name in ['Effect','TextEffect','Speed','PresentationOrder','DimHide','DimPrevious']:
                if info.hasPropertyByName(name):
                    value=authoring_enum(shape.getPropertyValue(name))
                    if isinstance(value,(str,int,float,bool)):fields[name]=value
            if fields:items.append({'objectPath':item['objectPath'],'properties':fields})
        return {'objects':items,'coverage':'legacy-object-properties','timingTreeCovered':False,'truncated':objects['truncated'],'canEdit':False}
    fail('NATIVE_QUERY_UNSUPPORTED','此结构化查询尚未接入。')

def authoring_guard(session,view,args):
    expected(session,view,args)
    for candidate in session['views'].values():
        if candidate.get('disposed'):continue
        editing=session['format'] in ['xlsx','pptx'] and (candidate.get('nativeEditing') or candidate.get('caretVisible'))
        if own_ime_pending(candidate) or editing:fail('NATIVE_PENDING_INPUT','原生视图仍在输入，未提交或移动人类选区。')
        if not candidate['frame'].getContainerWindow().isEnabled():fail('NATIVE_PENDING_INPUT','请先关闭此文档的模态对话框。')

def authoring_move_slide(session,view,source,destination):
    if globals().get('doc_call') is None:fail('BACKGROUND_EDIT_UNSUPPORTED','此后端没有独立后台页面顺序事务。')
    pages=session['doc'].getDrawPages();page=authoring_index(pages,source);authoring_index(pages,destination)
    before=[pages.getByIndex(index) for index in range(pages.getCount())]
    if source==destination:return {'slideIndex':source,'index':destination,'name':page.Name}
    human=[(candidate['controller'],candidate['controller'].getCurrentPage()) for candidate in session['views'].values() if not candidate.get('disposed')]
    prior=doc_call(session,'getView',I)();identifier=None
    try:
        view['internalManaged']=True
        try:identifier=doc_call(session,'createView',I)()
        finally:view['internalManaged']=False
        if identifier<0 or identifier==prior:fail('BACKGROUND_EDIT_UNSUPPORTED','无法创建同一模型的独立页面事务视图。')
        doc_call(session,'setView',None,I)(identifier);doc_call(session,'initializeForRendering',None,S)(b'{}');native_event_fence();doc_call(session,'setPart',None,I)(source)
        for index in range(pages.getCount()):doc_call(session,'selectPart',None,I,I)(index,0)
        doc_call(session,'selectPart',None,I,I)(source,1)
        doc_call(session,'moveSelectedParts',None,I,C.c_bool)(destination if destination>source else destination-1,False)
        native_event_fence()
        desired=list(before);desired.insert(destination,desired.pop(source));actual=[pages.getByIndex(index) for index in range(pages.getCount())]
        if actual!=desired:
            emit({'type':'diagnostic','code':'NATIVE_SLIDE_MOVE_READBACK','source':source,'destination':destination,'actualOrder':[before.index(value) if value in before else -1 for value in actual[:30]]})
            fail('NATIVE_READBACK_FAILED','原生幻灯片移动后的实际页面顺序与请求不一致。')
        if any(controller.getCurrentPage()!=original for controller,original in human):fail('NATIVE_READBACK_FAILED','原生页面移动影响了人类控制器，保留模型供恢复。')
        return {'slideIndex':source,'index':destination,'name':page.Name,'slideCount':pages.getCount()}
    finally:
        if identifier is not None and identifier>=0 and identifier!=prior:doc_call(session,'destroyView',None,I)(identifier)
        doc_call(session,'setView',None,I)(prior)

def authoring_replace_slide_text(session,view,op,args):
    if globals().get('doc_call') is None:fail('BACKGROUND_EDIT_UNSUPPORTED','此后端没有独立的后台文字事务控制器。')
    page,shape=authoring_shape(session,op)
    if len(op['objectPath'])!=1 or shape.supportsService('com.sun.star.drawing.GroupShape'):fail('BACKGROUND_EDIT_UNSUPPORTED','当前后台 Outliner 事务只接受明确的顶层文字对象。')
    text=shape.getText();full=text.getString()
    if full!=op['expectedText']:fail('REVISION_CONFLICT','对象全文已变化。')
    if full==op['text']:return {'slideIndex':op['slideIndex'],'objectPath':op['objectPath'],'text':full}
    humans=[(candidate,candidate['controller'].getCurrentPage(),selection_signature(selection(session,candidate))) for candidate in session['views'].values() if not candidate.get('disposed')]
    prior=doc_call(session,'getView',I)();identifier=None;callback=None;private=None
    try:
        controllers_before=model_controllers(session['doc']);view['internalManaged']=True
        try:identifier=doc_call(session,'createView',I)()
        finally:view['internalManaged']=False
        controllers_after=[controller for controller in model_controllers(session['doc']) if all(controller!=old for old in controllers_before)]
        if identifier<0 or identifier==prior or len(controllers_after)!=1:fail('BACKGROUND_EDIT_UNSUPPORTED','无法唯一绑定同模型后台文字控制器。')
        controller=controllers_after[0];private={'viewId':'semantic-'+str(uuid.uuid4()),'sessionId':session['sessionId'],'kitViewId':identifier,'controller':controller,'frame':controller.getFrame(),'disposed':False,'composition':None,'nativeEditing':False,'caretVisible':False,'windows':{},'selectionEpoch':0,'layoutRevision':0,'eventSequence':0,'renderGeneration':0,'actor':args.get('actor','agent')}
        doc_call(session,'setView',None,I)(identifier);doc_call(session,'initializeForRendering',None,S)(b'{}')
        @CALLBACK
        def callback(kind,payload,data):
            value=payload.decode('utf-8','replace') if payload else ''
            if kind==5:private['caretVisible']=value=='true';private['nativeEditing']=private['caretVisible']
            elif kind==68:
                try:info=json.loads(value);private['nativeEditing']=info.get('enabled') is True or info.get('enabled')=='true'
                except:private['nativeEditing']=True
            elif kind==36:window_event(private,value)
        callback_refs.append(callback);doc_call(session,'registerCallback',None,CALLBACK,P)(callback,None);native_event_fence();controller.setCurrentPage(page)
        expected(session,view,args)
        cursor=text.createTextCursor();cursor.gotoStart(False);cursor.gotoEnd(True);target=ppt_text_transaction_target(session,private,cursor,True)
        if target['shape']!=shape or target['page']!=page or target['index']!=op['objectPath'][0] or target['fullText']!=full:fail('REVISION_CONFLICT','后台真实全文范围与明确对象不一致。')
        manager=session['doc'].getUndoManager();manager.enterUndoContext('AgentViewer slides.replaceText')
        try:ppt_replace_text(session,private,target,{'expectedText':full,'text':op['text']},args)
        finally:manager.leaveUndoContext()
        controller.setCurrentPage(page);native_event_fence()
        actual=shape.getText().getString()
        if actual.replace('\r\n','\n').replace('\r','\n')!=op['text'].replace('\r\n','\n').replace('\r','\n'):fail('NATIVE_READBACK_FAILED','后台文字事务的对象全文回读不一致。')
        if any(candidate['controller'].getCurrentPage()!=original or selection_signature(selection(session,candidate))!=selected for candidate,original,selected in humans):fail('NATIVE_READBACK_FAILED','后台文字事务改变了人类页面或选区，保留当前模型供恢复。')
        return {'slideIndex':op['slideIndex'],'objectPath':op['objectPath'],'text':actual}
    finally:
        if identifier is not None and identifier>=0 and identifier!=prior:
            doc_call(session,'setView',None,I)(identifier)
            if callback is not None:doc_call(session,'registerCallback',None,CALLBACK,P)(CALLBACK(),None)
            doc_call(session,'destroyView',None,I)(identifier)
        if private is not None:private['disposed']=True
        if callback is not None:callback_refs[:]=[reference for reference in callback_refs if reference is not callback]
        doc_call(session,'setView',None,I)(prior)

def authoring_query_request(session,view,args):
    initial=state(session,view);data=authoring_query(session,view,args['target']);actual=state(session,view)
    if initial['engineRevision']!=actual['engineRevision'] or initial['engineEpoch']!=actual['engineEpoch']:fail('STALE_NATIVE_QUERY','结构化读取期间原生文档已变化，请重新读取。')
    if args['target']['kind']=='selection-target' and initial['selectionEpoch']!=actual['selectionEpoch']:fail('STALE_NATIVE_QUERY','读取原生目标期间选区已变化，请重新读取。')
    return {'state':actual,'data':data}

def authoring_private_command(session,view,command,values):
    if globals().get('doc_call') is None:fail('BACKGROUND_EDIT_UNSUPPORTED','此后端没有独立后台修订控制器。')
    prior=doc_call(session,'getView',I)();identifier=None
    try:
        previous=model_controllers(session['doc']);view['internalManaged']=True
        try:identifier=doc_call(session,'createView',I)()
        finally:view['internalManaged']=False
        found=[controller for controller in model_controllers(session['doc']) if all(controller!=old for old in previous)]
        if identifier<0 or identifier==prior or len(found)!=1:fail('BACKGROUND_EDIT_UNSUPPORTED','无法唯一创建后台修订控制器。')
        doc_call(session,'setView',None,I)(identifier);doc_call(session,'initializeForRendering',None,S)(b'{}');native_event_fence();frame=found[0].getFrame()
        if frame.queryDispatch(url(command),'',0) is None:fail('NATIVE_OPERATION_UNSUPPORTED','后台控制器不提供此明确修订事务。')
        dispatcher.executeDispatch(frame,command,'',0,props({**values,'SynchronMode':True}));native_event_fence()
    finally:
        if identifier is not None and identifier>=0 and identifier!=prior:doc_call(session,'destroyView',None,I)(identifier)
        doc_call(session,'setView',None,I)(prior)

def authoring_apply(session,view,op,args):
    kind=op['kind'];doc=session['doc'];authoring_format(session,kind)
    if kind in ['slides.setAnimation','word.acceptRevision','word.rejectRevision']:fail('BACKGROUND_EDIT_UNSUPPORTED','当前引擎没有通过独立控制器、撤销与后台目标验收；未改动人类页面或选区。')
    if kind=='slides.replaceText':return authoring_replace_slide_text(session,view,op,args)
    if kind=='slides.moveSlide':return authoring_move_slide(session,view,op['slideIndex'],op['index'])
    if kind in ['word.formatText','word.formatRangeText','word.formatParagraph','slides.formatObject','slides.formatText','sheets.formatRange']:
        if kind=='word.formatRangeText':
            retained,cursor=authoring_retained_word_range(session,op['anchor'],op['expectedText']);targets=[cursor];style_kind='text'
            def confirm():
                if session.get('authoringRanges',{}).get(op['anchor']) is not retained or cursor.String!=op['expectedText'] or native_text_container_id(session,cursor.Text)!=retained['containerId']:fail('REVISION_CONFLICT','保留文字目标已变化。')
        elif kind=='word.formatText':
            paragraph,cursor=authoring_text_range(session,op);targets=[cursor];style_kind='text'
            def confirm():authoring_text_range(session,op)
        elif kind=='word.formatParagraph':
            paragraph=authoring_paragraph(session,op['paragraphIndex']);targets=[paragraph];style_kind='paragraph'
            def confirm():
                if authoring_paragraph(session,op['paragraphIndex'])!=paragraph:fail('REVISION_CONFLICT','段落身份已变化。')
        elif kind=='sheets.formatRange':
            sheet=sheet_by_name(session,op['sheetName']);cells=checked_range(sheet,op['range']);targets=[cells];style_kind='cells'
            def confirm():
                if checked_range(sheet_by_name(session,op['sheetName']),op['range']).getRangeAddress()!=cells.getRangeAddress():fail('REVISION_CONFLICT','单元格范围已变化。')
        else:
            page,shape=authoring_shape(session,op);style_kind='shape' if kind=='slides.formatObject' else 'text'
            targets=[shape] if style_kind=='shape' else shape_style_text_targets(shape.getText(),True)[2]
            def confirm():
                if authoring_shape(session,op)!=(page,shape):fail('REVISION_CONFLICT','原生对象已变化。')
        plan=prepare_native_style(session,view,{'target':style_kind,'values':op['values']},targets,True)
        apply_actual_style_plans(session,view,[plan],args,confirm,style_kind=='text')
        fields=authoring_inspect_style(session,style_kind,targets,op['values'])
        if any(value['state']=='mixed' or value['value']!=op['values'][name] for name,value in fields.items()):fail('NATIVE_STYLE_APPLY_FAILED','显式目标样式回读未与请求一致。')
        result={'fields':fields}
        if kind=='word.formatRangeText':result.update({'text':cursor.String,'target':authoring_word_target(session,view,cursor)})
        return result
    manager=doc.getUndoManager()
    if manager.isLocked():fail('NATIVE_UNDO_BUSY','原生撤销事务尚未结束。')
    # A context groups history; it does not promise rollback or cross-operation atomicity.
    manager.enterUndoContext('AgentViewer '+kind)
    try:
        if kind=='word.replaceText':
            paragraph,cursor=authoring_text_range(session,op);return authoring_word_replace(session,view,cursor,op['text'])
        if kind=='word.replaceRangeText':
            retained,cursor=authoring_retained_word_range(session,op['anchor'],op['expectedText']);return authoring_word_replace(session,view,cursor,op['text'])
        if kind=='word.pageLayout':
            styles=doc.getStyleFamilies().getByName('PageStyles')
            if not styles.hasByName(op['pageStyleName']):fail('INVALID_TARGET','目标页面样式不存在。')
            style=styles.getByName(op['pageStyleName'])
            if 'landscape' in op:
                landscape=op['landscape'];style.IsLandscape=landscape
                if (style.Width>style.Height)!=landscape:width=style.Width;style.Width=style.Height;style.Height=width
            for side in ['left','right','top','bottom']:
                if side in op:setattr(style,side.capitalize()+'Margin',round(op[side]*100))
            actual=next(value for value in authoring_query(session,view,{'kind':'word.pageStyles'})['styles'] if value['name']==op['pageStyleName'])
            if any(actual[key]!=round(value*100)/100 if key!='landscape' else actual[key]!=value for key,value in op.items() if key in ['landscape','left','right','top','bottom']):fail('NATIVE_READBACK_FAILED','页面样式回读不一致。')
            return actual
        if kind=='word.setTracking':
            prior=bool(doc.RecordChanges);doc.RecordChanges=op['enabled']
            if prior!=op['enabled']:doc.setModified(True)
            if bool(doc.RecordChanges)!=op['enabled']:fail('NATIVE_READBACK_FAILED','修订记录开关回读不一致。')
            return {'tracking':bool(doc.RecordChanges)}
        if kind=='word.insertTable':
            rows=op['rows'];width=len(rows[0])
            if any(len(row)!=width for row in rows):fail('INVALID_TARGET','表格数据必须是矩形。')
            paragraph=authoring_paragraph(session,op['paragraphIndex']);table=doc.createInstance('com.sun.star.text.TextTable');table.initialize(len(rows),width);cursor=paragraph.Text.createTextCursorByRange(paragraph.getEnd());paragraph.Text.insertControlCharacter(cursor,constant('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK',0),False);paragraph.Text.insertTextContent(cursor,table,False)
            for row_index,row in enumerate(rows):
                for column_index,text in enumerate(row):table.getCellByName(letter(column_index)+str(row_index+1)).String=text
            if any(table.getCellByName(letter(column_index)+str(row_index+1)).String!=text for row_index,row in enumerate(rows) for column_index,text in enumerate(row)):fail('NATIVE_READBACK_FAILED','原生表格单元格回读不一致。')
            return authoring_query(session,view,{'kind':'word.table','tableName':table.Name})
        if kind=='word.setTableCell':
            tables=doc.getTextTables()
            if not tables.hasByName(op['tableName']):fail('INVALID_TARGET','表格名称不存在。')
            table=tables.getByName(op['tableName'])
            if op['cellName'] not in table.getCellNames():fail('INVALID_TARGET','表格单元格名称不存在。')
            cell=table.getCellByName(op['cellName'])
            if cell.String!=op['expectedText']:fail('REVISION_CONFLICT','表格单元格内容已变化。')
            cell.String=op['text']
            if cell.String!=op['text']:fail('NATIVE_READBACK_FAILED','原生表格单元格回读不一致。')
            return {'tableName':op['tableName'],'cellName':op['cellName'],'text':cell.String}
        if kind=='word.resolveRevision':
            redlines=authoring_redlines(session)
            if redlines is None:fail('BACKGROUND_EDIT_UNSUPPORTED','此引擎无法提供可验证的原生修订身份。')
            if op['revisionIndex']>=len(redlines):fail('INVALID_TARGET','目标修订已变化。')
            identifier=redlines[op['revisionIndex']]['index'];command='AcceptTrackedChange' if op['action']=='accept' else 'RejectTrackedChange'
            authoring_private_command(session,view,'.uno:'+command,{command:uno.Any('unsigned long',identifier)})
            actual=authoring_redlines(session)
            if actual is None or any(value['index']==identifier for value in actual):fail('NATIVE_READBACK_FAILED','目标修订未实际处理。')
            if {value['index'] for value in actual}!={value['index'] for value in redlines if value['index']!=identifier}:fail('NATIVE_READBACK_FAILED','此次修订处理还影响了其他原生修订，请读取当前模型恢复。')
            return {'revisionIndex':op['revisionIndex'],'action':op['action'],'remaining':len(actual)}
        if kind=='word.addComment':
            paragraph,cursor=authoring_text_range(session,op);field=doc.createInstance('com.sun.star.text.textfield.Annotation');field.Content=op['text'];field.Author=op['author'];paragraph.Text.insertTextContent(cursor,field,True)
            if field.Content!=op['text'] or field.Author!=op['author']:fail('NATIVE_READBACK_FAILED','批注内容回读不一致。')
            return {'commentIndex':authoring_comments(doc).index(field),'text':field.Content,'author':field.Author}
        if kind=='word.deleteComment':
            fields=authoring_comments(doc)
            if op['commentIndex']>=len(fields) or fields[op['commentIndex']].Content!=op['expectedText']:fail('REVISION_CONFLICT','目标批注已变化。')
            field=fields[op['commentIndex']];field.dispose()
            if field in authoring_comments(doc):fail('NATIVE_READBACK_FAILED','批注未实际删除。')
            return {'deleted':True}
        if kind=='sheets.setRangeValues':
            sheet=sheet_by_name(session,op['sheetName']);cells=checked_range(sheet,op['range']);address=cells.getRangeAddress();height=address.EndRow-address.StartRow+1;width=address.EndColumn-address.StartColumn+1
            if len(op['rows'])!=height or any(len(row)!=width for row in op['rows']):fail('INVALID_TARGET','数据矩阵必须与明确的目标区域大小一致。')
            # Parse every formula before changing any cell. Later native setter
            # failures can still be partial; no atomic rollback is advertised.
            prepared=[];formats=doc.getNumberFormats();format_info={};standard_formats={};logical_type=constant('com.sun.star.util.NumberFormat.LOGICAL',1024)
            for row_index,row in enumerate(op['rows']):
                for column_index,value in enumerate(row):
                    cell=cells.getCellByPosition(column_index,row_index);tokens=None;key=int(cell.NumberFormat)
                    if key not in format_info:format_info[key]=formats.getByKey(key)
                    previous=format_info[key];format_key=None
                    if type(value) is bool or int(previous.Type)&logical_type:
                        wanted=logical_type if type(value) is bool else constant('com.sun.star.util.NumberFormat.NUMBER',16);locale=previous.Locale;locale_key=(wanted,locale.Language,locale.Country,locale.Variant)
                        if locale_key not in standard_formats:standard_formats[locale_key]=formats.getStandardFormat(wanted,locale)
                        format_key=standard_formats[locale_key]
                        if type(value) is bool and not int(formats.getByKey(format_key).Type)&logical_type:fail('NATIVE_LOGICAL_UNAVAILABLE','原生引擎没有可验证的逻辑格式。')
                    if isinstance(value,str) and value.startswith('='):
                        tokens=excel_formula_parser(session).parseFormula(value,cell.getCellAddress())
                        if not tokens:fail('INVALID_NATIVE_FORMULA','公式没有有效的原生 token。')
                    prepared.append((cell,value,tokens,format_key))
            for cell,value,tokens,format_key in prepared:
                if format_key is not None and int(cell.NumberFormat)!=format_key:cell.NumberFormat=format_key
                if tokens is not None:cell.setTokens(tokens)
                elif value is None:cell.setString('')
                elif type(value) is bool:cell.setValue(1. if value else 0.)
                elif isinstance(value,(int,float)):cell.setValue(float(value))
                else:cell.setString(value)
            actual=authoring_query(session,view,{'kind':'sheets.range','sheetName':op['sheetName'],'range':op['range']})
            for row_index,row in enumerate(op['rows']):
                for column_index,value in enumerate(row):
                    if isinstance(value,str) and value.startswith('='):
                        cell=cells.getCellByPosition(column_index,row_index)
                        if cell.getType().value!='FORMULA' or list(cell.getTokens())!=list(prepared[row_index*width+column_index][2]):fail('NATIVE_READBACK_FAILED','公式 token 回读不一致。')
                    elif type(value) is bool:
                        if type(actual['values'][row_index][column_index]) is not bool or actual['values'][row_index][column_index]!=value or actual['kinds'][row_index][column_index]!='logical':fail('NATIVE_READBACK_FAILED','原生逻辑值及类型回读不一致。')
                    elif actual['values'][row_index][column_index]!=('' if value is None else value) or isinstance(value,(int,float)) and type(actual['values'][row_index][column_index]) is bool:fail('NATIVE_READBACK_FAILED','单元格实际值及类型回读不一致。')
            return actual
        if kind=='sheets.grid':
            sheet=sheet_by_name(session,op['sheetName']);collection=sheet.getRows() if op['action'].endswith('Rows') else sheet.getColumns();before=collection.getCount();index=op['index'];count=op['count']
            if index>=before or op['action'].startswith('delete') and index+count>before:fail('INVALID_TARGET','行列结构范围超出工作表。')
            if op['action'].startswith('insert'):collection.insertByIndex(index,count)
            else:collection.removeByIndex(index,count)
            # Calc grids have fixed capacity; the actual resulting boundary
            # cells and used range are returned rather than a fabricated count.
            cursor=sheet.createCursor();cursor.gotoEndOfUsedArea(False)
            return {'sheetName':op['sheetName'],'action':op['action'],'index':index,'count':count,'usedRange':range_name(cursor.getRangeAddress()),'boundary':query_cell_range(session,sheet.getCellRangeByPosition(0,index,0,min(index+count,before-1))) if op['action'].endswith('Rows') else query_cell_range(session,sheet.getCellRangeByPosition(index,0,min(index+count,before-1),0))}
        if kind in ['sheets.addSheet','sheets.renameSheet','sheets.deleteSheet']:
            sheets=doc.getSheets()
            if kind=='sheets.addSheet':
                index=op.get('index',sheets.getCount())
                if sheets.hasByName(op['name']) or index>sheets.getCount():fail('INVALID_TARGET','新工作表名称重复或索引越界。')
                sheets.insertNewByName(op['name'],index)
                if sheets.getByIndex(index).Name!=op['name']:fail('NATIVE_READBACK_FAILED','新工作表回读不一致。')
            elif kind=='sheets.renameSheet':
                sheet=sheet_by_name(session,op['sheetName'])
                if sheets.hasByName(op['name']) and op['name']!=op['sheetName']:fail('INVALID_TARGET','新工作表名称已存在。')
                sheet.Name=op['name']
                if sheet.Name!=op['name']:fail('NATIVE_READBACK_FAILED','工作表名称回读不一致。')
            else:
                sheet_by_name(session,op['sheetName'])
                if sheets.getCount()<=1:fail('INVALID_TARGET','工作簿至少保留一个工作表。')
                # Deleting the human's active sheet necessarily navigates it.
                if any(candidate['controller'].getActiveSheet().Name==op['sheetName'] for candidate in session['views'].values() if not candidate.get('disposed')):fail('BACKGROUND_EDIT_UNSUPPORTED','不能在后台删除人类控制器当前工作表。')
                sheets.removeByName(op['sheetName'])
                if sheets.hasByName(op['sheetName']):fail('NATIVE_READBACK_FAILED','工作表未实际删除。')
            return {'sheets':[{'index':index,'name':sheets.getByIndex(index).Name} for index in range(sheets.getCount())]}
        if kind=='sheets.merge':
            cells=checked_range(sheet_by_name(session,op['sheetName']),op['range'])
            if op['merge'] and any(value!='' for row_index,row in enumerate(cells.getDataArray()) for column_index,value in enumerate(row) if row_index or column_index):fail('MERGE_WOULD_DISCARD_DATA','合并会丢弃非主单元格数据，没有执行。')
            cells.merge(op['merge'])
            if bool(cells.getIsMerged())!=op['merge']:fail('NATIVE_READBACK_FAILED','单元格合并状态回读不一致。')
            return {'sheetName':op['sheetName'],'range':op['range'],'merged':bool(cells.getIsMerged())}
        if kind=='sheets.sort':
            cells=checked_range(sheet_by_name(session,op['sheetName']),op['range']);address=cells.getRangeAddress()
            if op['column']>address.EndColumn-address.StartColumn:fail('INVALID_TARGET','排序列必须是目标区域内的零基列索引。')
            field=uno.createUnoStruct('com.sun.star.table.TableSortField');field.Field=op['column'];field.IsAscending=not op['descending'];field.IsCaseSensitive=False;locale=cells.CharLocale
            descriptor={value.Name:value.Value for value in cells.createSortDescriptor()};descriptor.update({'SortFields':uno.Any('[]com.sun.star.table.TableSortField',(field,)),'ContainsHeader':op['header'],'IsSortColumns':False,'SortColumns':False,'CollatorLocale':locale,'IsCaseSensitive':False});cells.sort(props(descriptor))
            actual=authoring_query(session,view,{'kind':'sheets.range','sheetName':op['sheetName'],'range':op['range']});keys=[row[op['column']] for row in actual['values'][1 if op['header'] else 0:]]
            collator=ctx.ServiceManager.createInstanceWithContext('com.sun.star.i18n.Collator',ctx);collator.loadDefaultCollator(locale,1)
            for left,right in zip(keys,keys[1:]):
                if left=='' or right=='':continue
                compare=(left>right)-(left<right) if isinstance(left,(int,float)) and isinstance(right,(int,float)) else collator.compareString(str(left),str(right)) if isinstance(left,str) and isinstance(right,str) else 0
                if compare<0 if op['descending'] else compare>0:fail('NATIVE_READBACK_FAILED','实际排序关键列未通过顺序回读。')
            return actual
        if kind=='sheets.filter':
            cells=checked_range(sheet_by_name(session,op['sheetName']),op['range']);address=cells.getRangeAddress();ranges=doc.DatabaseRanges;name='AVFilter_'+str(address.Sheet)+'_'+hashlib.sha256(op['range'].encode()).hexdigest()[:12]
            if op['enabled']:
                if not ranges.hasByName(name):ranges.addNewByName(name,address)
                actual=ranges.getByName(name)
                if actual.getDataArea()!=address:fail('REVISION_CONFLICT','此筛选名称已绑定其他区域。')
                actual.AutoFilter=True
                if not actual.AutoFilter:fail('NATIVE_READBACK_FAILED','自动筛选状态回读不一致。')
            elif ranges.hasByName(name):
                actual=ranges.getByName(name)
                if actual.getDataArea()!=address:fail('REVISION_CONFLICT','此筛选名称已绑定其他区域。')
                actual.AutoFilter=False;ranges.removeByName(name)
            return {'sheetName':op['sheetName'],'range':op['range'],'enabled':ranges.hasByName(name) and bool(ranges.getByName(name).AutoFilter)}
        if kind=='sheets.setValidation':
            target=checked_range(sheet_by_name(session,op['sheetName']),op['range']);value=target.Validation
            value.Type=uno.Enum('com.sun.star.sheet.ValidationType',op['type']);value.Operator=uno.Enum('com.sun.star.sheet.ConditionOperator',op['operator']);value.setFormula1(op['formula1']);value.setFormula2(op['formula2']);value.IgnoreBlankCells=op['allowEmpty'];value.ShowErrorMessage=op['showError'];value.ErrorTitle=op['errorTitle'];value.ErrorMessage=op['errorMessage'];target.Validation=value
            actual=authoring_query(session,view,{'kind':'sheets.validation','sheetName':op['sheetName'],'range':op['range']})
            if any(actual[key]!=op[key] for key in ['type','operator','formula1','formula2','allowEmpty','showError','errorTitle','errorMessage']):fail('NATIVE_READBACK_FAILED','数据验证回读不一致。')
            return actual
        if kind in ['sheets.addChart','sheets.deleteChart']:
            sheet=sheet_by_name(session,op['sheetName']);charts=sheet.getCharts();exists=charts.hasByName(op['name'])
            if kind=='sheets.deleteChart':
                if not exists:fail('INVALID_TARGET','图表名称不存在。')
                charts.removeByName(op['name'])
                if charts.hasByName(op['name']):fail('NATIVE_READBACK_FAILED','图表未实际删除。')
                return {'deleted':True,'name':op['name']}
            if exists:fail('INVALID_TARGET','图表名称已存在。')
            address=checked_range(sheet,op['range']).getRangeAddress();rectangle=uno.createUnoStruct('com.sun.star.awt.Rectangle');rectangle.X=round(op['x']*100);rectangle.Y=round(op['y']*100);rectangle.Width=round(op['width']*100);rectangle.Height=round(op['height']*100)
            charts.addNewByName(op['name'],rectangle,(address,),op['columnHeaders'],op['rowHeaders'])
            chart_doc=charts.getByName(op['name']).getEmbeddedObject();service={'column':'BarDiagram','bar':'BarDiagram','line':'LineDiagram','pie':'PieDiagram','scatter':'XYDiagram','area':'AreaDiagram'}[op['type']];diagram=chart_doc.createInstance('com.sun.star.chart.'+service);chart_doc.setDiagram(diagram)
            if op['type'] in ['bar','column']:diagram.Vertical=op['type']=='bar'
            actual=next((value for value in authoring_query(session,view,{'kind':'sheets.charts','sheetName':op['sheetName']})['charts'] if value['name']==op['name']),None)
            if actual is None or actual['type']!=op['type'] or actual['columnHeaders']!=op['columnHeaders'] or actual['rowHeaders']!=op['rowHeaders'] or actual['ranges']!=[{'sheetIndex':address.Sheet,'range':range_name(address)}]:fail('NATIVE_READBACK_FAILED','图表类型或源区域回读不一致。')
            return actual
        if kind in ['sheets.addPivot','sheets.deletePivot']:
            sheet=sheet_by_name(session,op['sheetName']);tables=sheet.getDataPilotTables();exists=tables.hasByName(op['name'])
            if kind=='sheets.deletePivot':
                if not exists:fail('INVALID_TARGET','透视表名称不存在。')
                tables.removeByName(op['name'])
                if tables.hasByName(op['name']):fail('NATIVE_READBACK_FAILED','透视表未实际删除。')
                return {'deleted':True,'name':op['name']}
            if exists:fail('INVALID_TARGET','透视表名称已存在。')
            source=checked_range(sheet,op['range']);destination=checked_range(sheet,op['destination']);address=source.getRangeAddress();dest=destination.getRangeAddress()
            if address.StartColumn<=dest.StartColumn<=address.EndColumn and address.StartRow<=dest.StartRow<=address.EndRow:fail('INVALID_TARGET','透视表起点不能覆盖源区域。')
            descriptor=tables.createDataPilotDescriptor();descriptor.setSourceRange(address);fields=descriptor.getDataPilotFields();used=op['rows']+op['columns']+[value['field'] for value in op['data']]
            if len(set(used))!=len(used) or any(not fields.hasByName(name) for name in used):fail('INVALID_TARGET','透视字段必须唯一且存在于源表标题。')
            for names,orientation in [(op['rows'],'ROW'),(op['columns'],'COLUMN')]:
                for name in names:fields.getByName(name).Orientation=uno.Enum('com.sun.star.sheet.DataPilotFieldOrientation',orientation)
            for item in op['data']:
                field=fields.getByName(item['field']);field.Orientation=uno.Enum('com.sun.star.sheet.DataPilotFieldOrientation','DATA');field.Function=uno.Enum('com.sun.star.sheet.GeneralFunction',item['function'])
            tables.insertNewByName(op['name'],destination.getCellAddress(),descriptor)
            actual=next((value for value in authoring_query(session,view,{'kind':'sheets.pivots','sheetName':op['sheetName']})['pivots'] if value['name']==op['name']),None)
            if actual is None or actual['sourceRange']!=range_name(address):fail('NATIVE_READBACK_FAILED','透视表源区域回读不一致。')
            return actual
        if kind=='slides.applyMaster':
            page=authoring_index(doc.getDrawPages(),op['slideIndex']);master=authoring_index(doc.getMasterPages(),op['masterIndex']);page.setMasterPage(master)
            if page.getMasterPage()!=master:fail('NATIVE_READBACK_FAILED','幻灯片母版回读不一致。')
            return {'slideIndex':op['slideIndex'],'masterIndex':op['masterIndex'],'name':master.Name}
        if kind=='slides.add':
            pages=doc.getDrawPages();index=op.get('index',pages.getCount());before=pages.getCount()
            if index>before:fail('INVALID_TARGET','新增幻灯片索引超出范围。')
            if index==0 and globals().get('doc_call') is None:fail('BACKGROUND_EDIT_UNSUPPORTED','此后端不能保证插入首页时保留人类页面。')
            # Impress' UNO insertion is after nIndex, unlike its method name.
            page=pages.insertNewByIndex(max(0,index-1))
            if index==0:authoring_move_slide(session,view,1,0)
            if op['title']:
                shape=doc.createInstance('com.sun.star.drawing.TextShape');shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',1000,1000);shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',max(100,page.Width-2000),3000);page.add(shape);shape.String=op['title']
                if shape.String!=op['title']:fail('NATIVE_READBACK_FAILED','新幻灯片标题回读不一致。')
            if pages.getCount()!=before+1 or pages.getByIndex(index)!=page:fail('NATIVE_READBACK_FAILED','新增幻灯片位置回读不一致。')
            return {'slideIndex':index,**authoring_shapes(page)}
        if kind=='slides.delete':
            pages=doc.getDrawPages();page=authoring_index(pages,op['slideIndex']);before=pages.getCount()
            if before<=1:fail('INVALID_TARGET','演示文稿至少保留一页。')
            if any(candidate['controller'].getCurrentPage()==page for candidate in session['views'].values() if not candidate.get('disposed')):fail('BACKGROUND_EDIT_UNSUPPORTED','不能在后台删除人类控制器当前幻灯片。')
            pages.remove(page)
            if pages.getCount()!=before-1 or any(pages.getByIndex(index)==page for index in range(pages.getCount())):fail('NATIVE_READBACK_FAILED','幻灯片未实际删除。')
            return {'deleted':True,'slideCount':pages.getCount()}
        if kind=='slides.duplicate':
            pages=doc.getDrawPages();page=authoring_index(pages,op['slideIndex']);before=pages.getCount();copy=doc.duplicate(page);index=next((index for index in range(pages.getCount()) if pages.getByIndex(index)==copy),None)
            if pages.getCount()!=before+1 or index is None:fail('NATIVE_READBACK_FAILED','幻灯片副本没有实际页面身份。')
            return {'slideIndex':index,**authoring_shapes(copy)}
        if kind=='slides.setNotes':
            page=authoring_index(doc.getDrawPages(),op['slideIndex']);notes=page.getNotesPage();found=[notes.getByIndex(index) for index in range(notes.getCount()) if notes.getByIndex(index).ShapeType=='com.sun.star.presentation.NotesShape']
            if len(found)!=1:fail('INVALID_TARGET','原生备注正文不唯一。')
            shape=found[0];before=shape.String
            if before!=op['text']:
                shape.String=op['text']
                manager.addUndoAction(AuthoringTextUndo('AgentViewer notes',shape,before,op['text'],doc))
                doc.setModified(True)
            if shape.String!=op['text']:fail('NATIVE_READBACK_FAILED','原生备注正文回读不一致。')
            return {'slideIndex':op['slideIndex'],'text':shape.String}
        if kind=='slides.setBackground':
            page=authoring_index(doc.getDrawPages(),op['slideIndex']);background=doc.createInstance('com.sun.star.drawing.Background');background.FillStyle=uno.Enum('com.sun.star.drawing.FillStyle','SOLID');background.FillColor=int(op['color'],16);page.Background=background
            if page.Background.FillColor!=int(op['color'],16) or authoring_enum(page.Background.FillStyle)!='SOLID':fail('NATIVE_READBACK_FAILED','原生页面背景回读不一致。')
            return {'slideIndex':op['slideIndex'],'color':format(page.Background.FillColor&0xffffff,'06x')}
        if kind=='slides.group':
            page=authoring_index(doc.getDrawPages(),op['slideIndex']);indices=[path[0] for path in op['objectPaths']]
            if len(set(indices))!=len(indices):fail('INVALID_TARGET','组合对象路径必须互不重复。')
            shapes=[authoring_index(page,index) for index in indices];collection=ctx.ServiceManager.createInstanceWithContext('com.sun.star.drawing.ShapeCollection',ctx)
            if collection is None:fail('NATIVE_OPERATION_UNSUPPORTED','当前引擎没有可用的对象组合集合。')
            for shape in shapes:collection.add(shape)
            group=page.group(collection)
            if group is None or group.getCount()!=len(shapes) or any(group.getByIndex(index) not in shapes for index in range(group.getCount())):fail('NATIVE_READBACK_FAILED','组合对象成员回读不一致。')
            path=next(([index] for index in range(page.getCount()) if page.getByIndex(index)==group),None)
            if path is None:fail('NATIVE_READBACK_FAILED','组合对象没有可验证的页面路径。')
            return {'slideIndex':op['slideIndex'],'objectPath':path,'children':authoring_shapes(group)['objects']}
        if kind=='slides.ungroup':
            page,group=authoring_shape(session,op)
            if not group.supportsService('com.sun.star.drawing.GroupShape'):fail('INVALID_TARGET','目标不是顶层组合对象。')
            shapes=[group.getByIndex(index) for index in range(group.getCount())];page.ungroup(group);paths=[]
            for shape in shapes:
                path=next(([index] for index in range(page.getCount()) if page.getByIndex(index)==shape),None)
                if path is None:fail('NATIVE_READBACK_FAILED','取消组合后的对象没有可验证的页面路径。')
                paths.append(path)
            return {'slideIndex':op['slideIndex'],'objectPaths':paths}
        if kind=='slides.setLegacyAnimation':
            page,shape=authoring_shape(session,op);info=shape.getPropertySetInfo()
            if not all(info.hasPropertyByName(name) for name in ['Effect','Speed']):fail('NATIVE_OPERATION_UNSUPPORTED','对象不支持旧式动画属性。')
            effect=uno.Enum('com.sun.star.presentation.AnimationEffect',op['effect']);speed=uno.Enum('com.sun.star.presentation.AnimationSpeed',op['speed']);shape.Effect=effect;shape.Speed=speed
            if authoring_enum(shape.Effect)!=op['effect'] or authoring_enum(shape.Speed)!=op['speed']:fail('NATIVE_READBACK_FAILED','对象旧式动画属性回读不一致。')
            return {'slideIndex':op['slideIndex'],'objectPath':op['objectPath'],'effect':authoring_enum(shape.Effect),'speed':authoring_enum(shape.Speed),'coverage':'legacy-object-properties','timingTreeCovered':False}
        fail('NATIVE_OPERATION_UNSUPPORTED','此结构化修改尚未接入。')
    finally:manager.leaveUndoContext()

class AuthoringTextUndo(unohelper.Base,XUndoAction):
    def __init__(self,title,target,before,after,doc):self.title=title;self.Title=title;self.target=target;self.before=before;self.after=after;self.doc=doc
    def getTitle(self):return self.title
    def undo(self):self.target.String=self.before;self.doc.setModified(True)
    def redo(self):self.target.String=self.after;self.doc.setModified(True)

def authoring_remember(session,key,value):
    receipts=session.setdefault('authoringReceipts',{});value['bytes']=len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode());receipts[key]=value;session['authoringReceiptBytes']=session.get('authoringReceiptBytes',0)+value['bytes'];session['authoringReceiptCount']=session.get('authoringReceiptCount',0)+1
    while session['authoringReceiptBytes']>4*1024*1024 or session['authoringReceiptCount']>300:
        retired=next((item for item in receipts.values() if 'bytes' in item),None)
        if retired is None:break
        session['authoringReceiptBytes']-=retired.pop('bytes');session['authoringReceiptCount']-=1;retired.pop('result',None);retired.pop('error',None);retired['expired']=True

def authoring_execute(session,view,args):
    key=args['requestId'];signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest();receipts=session.setdefault('authoringReceipts',{});prior=receipts.get(key)
    if prior:
        if prior['signature']!=signature:fail('IDEMPOTENCY_CONFLICT','请求身份已用于另一操作。')
        if prior.get('expired'):fail('NATIVE_REQUEST_RECEIPT_EXPIRED','原生请求已完成且完整回执过期，不会重复执行修改。')
        if 'error' in prior:fail(prior['error'][0],prior['error'][1])
        return prior['result']
    if len(receipts)>=10000:fail('NATIVE_REQUEST_LEDGER_FULL','原生请求身份账本已满，请先保存并重新建立文档会话。')
    authoring_guard(session,view,args);before=session['engineRevision'];session['operationActor']=args.get('actor','agent')
    try:
        history=undo_state(session);manager=session['doc'].getUndoManager();native_history=(tuple(manager.getAllUndoActionTitles()),tuple(manager.getAllRedoActionTitles()));data=authoring_apply(session,view,args['operation'],args)
        # Native modify notifications are authoritative. Do not mark an edit
        # successful merely because an UNO setter returned without an error.
        if globals().get('reconcile_history_revision'):reconcile_history_revision(session,before,native_history)
        actual=state(session,view);after_history=(tuple(manager.getAllUndoActionTitles()),tuple(manager.getAllRedoActionTitles()));changed=actual['engineRevision']!=before or after_history!=native_history
        target=data.get('target') if isinstance(data,dict) else None
        if target and target.get('kind')=='word.nativeRange':
            retained=session.get('authoringRanges',{}).get(target['anchor'])
            if retained is None:fail('NATIVE_READBACK_FAILED','新原生文字范围未能保留。')
            retained['revision']=actual['engineRevision']
        result={'status':'applied' if changed else 'no-change','state':actual,'readback':data,'verified':True}
        if changed and args['operation']['kind'] not in ['slides.add','slides.duplicate','slides.setBackground','slides.setLegacyAnimation','slides.applyMaster'] and after_history[0]!=native_history[0] and undo_state(session).get('canUndo'):result['undoToken']=undo_state(session).get('token')
        elif changed:result['warnings']=['NATIVE_UNDO_UNAVAILABLE_FOR_OPERATION']
        authoring_remember(session,key,{'signature':signature,'result':result})
        return result
    except Exception as error:
        message=str(error);code,separator,detail=message.partition('|')
        if not separator:
            trace=error.__traceback__
            while trace is not None and trace.tb_next is not None:trace=trace.tb_next
            emit({'type':'diagnostic','code':'NATIVE_AUTHORING_FAILED','operation':args.get('operation',{}).get('kind'),'errorType':type(error).__name__,'line':trace.tb_lineno if trace is not None else None})
        actual_code=code if separator else 'NATIVE_AUTHORING_FAILED';actual_message=detail if separator else '原生结构化编辑失败；保留当前模型，请重新读取后恢复。'
        if session['engineRevision']!=before:actual_code='NATIVE_PARTIAL_FAILURE';actual_message='操作在原生模型发生变化后未通过完整验证；请读取当前模型恢复，不会自动重试。原因为：'+actual_message
        authoring_remember(session,key,{'signature':signature,'error':(actual_code,actual_message)})
        fail(actual_code,actual_message)
    finally:session['operationActor']=None
`;
