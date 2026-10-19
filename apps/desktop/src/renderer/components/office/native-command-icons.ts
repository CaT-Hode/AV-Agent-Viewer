import {
  AlignCenter, AlignCenterVertical, AlignEndVertical, AlignHorizontalSpaceBetween,
  AlignJustify, AlignLeft, AlignRight, AlignStartVertical, AlignVerticalSpaceBetween,
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  ArrowUpDown, BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd,
  BetweenVerticalStart, Bold, BookA, BookMarked, BookmarkPlus,
  Braces, BringToFront, Calculator, ChartColumnIncreasing, Check, Circle, CircleDollarSign,
  CirclePlay, Columns2, Columns3, Copy, Eraser, Eye, EyeOff,
  File, FileCheck, FileCog, FileDiff, FileDigit, FilePenLine, FilePlus2,
  Files, FileSearch, FileSliders, FileStack, FileText, FileType2,
  Filter, FilterX, FlipHorizontal2, FlipVertical2, Grid2X2, Group, Hash,
  Highlighter, ImagePlus, Italic, Layers, LayersArrowDown, LayersArrowUp,
  LayoutTemplate, Link, List, ListChecks, ListOrdered, ListRestart, ListTree,
  Lock, LockKeyhole, Merge, MessageSquareCheck, MessageSquarePlus,
  MessageSquareReply, MessageSquareText, Move, MoveHorizontal, MoveVertical,
  NotebookPen, Omega, PaintBucket, PaintRoller, PanelBottom, PanelTop, PanelTopClose,
  PanelsLeftRight, PanelsTopBottom, Percent, Pilcrow, Play, Plus, Presentation,
  Printer, PrinterCheck, RectangleHorizontal, RefreshCw, ScanEye, ScanLine,
  ScanText, SendToBack, Sheet, Sigma, SlidersHorizontal, SpellCheck, Split,
  SquareDashed, SquareDashedMousePointer, SquareFunction, SquarePen, SquarePlay,
  Strikethrough, Subscript, Superscript, Table2, TableCellsMerge,
  TableCellsSplit, TableColumnsSplit, TableOfContents, TableProperties,
  TableRowsSplit, Tags, TextCursorInput, TextQuote, Underline, Ungroup,
  WandSparkles, WrapText, X, type LucideIcon,
} from 'lucide-react';
import type { NativeOfficeFormat } from '../../../../../../packages/contracts/src/native-office';

export type NativeOfficeToolIcon = { icon: LucideIcon; badge?: LucideIcon };
const icon = (value: LucideIcon, badge?: LucideIcon): NativeOfficeToolIcon => ({ icon: value, badge });

// Presentation only: a glyph never implies that the engine supports a command.
// Shared command identities keep their meaning; compound marks distinguish row,
// column, sheet and slide actions without replacing their accessible names.
const commands: Record<string, NativeOfficeToolIcon> = {
  Bold: icon(Bold), Italic: icon(Italic), Underline: icon(Underline), Strikeout: icon(Strikethrough),
  SuperScript: icon(Superscript), SubScript: icon(Subscript), FontDialog: icon(FileType2), ResetAttributes: icon(Eraser),
  LeftPara: icon(AlignLeft), CenterPara: icon(AlignCenter), RightPara: icon(AlignRight), JustifyPara: icon(AlignJustify),
  DefaultBullet: icon(List), DefaultNumbering: icon(ListOrdered), ParagraphDialog: icon(Pilcrow),
  DesignerDialog: icon(PaintRoller), EditStyle: icon(FilePenLine), StyleNewByExample: icon(PaintRoller, Plus), StyleUpdateByExample: icon(PaintRoller, RefreshCw),
  InsertGraphic: icon(ImagePlus), InsertSymbol: icon(Omega), InsertObject: icon(SquareDashedMousePointer),
  InsertTextBox: icon(TextCursorInput), HyperlinkDialog: icon(Link),
  InsertPageNumberField: icon(FileDigit), InsertPageCountField: icon(Files, Hash), InsertField: icon(Braces), FieldDialog: icon(Braces, SlidersHorizontal),
  InsertTable: icon(Table2, Plus), TableDialog: icon(TableProperties), TableNumberFormatDialog: icon(Table2, Hash), TableCellBackgroundColor: icon(Table2, PaintBucket),
  InsertRowsBefore: icon(BetweenHorizontalStart), InsertRowsAfter: icon(BetweenHorizontalEnd),
  InsertColumnsBefore: icon(BetweenVerticalStart), InsertColumnsAfter: icon(BetweenVerticalEnd),
  DeleteRows: icon(TableRowsSplit, X), DeleteColumns: icon(TableColumnsSplit, X), DeleteTable: icon(Table2, X),
  MergeCells: icon(TableCellsMerge), SplitCell: icon(TableCellsSplit), SplitTable: icon(TableRowsSplit), MergeTable: icon(Table2, Merge),
  DistributeRows: icon(AlignVerticalSpaceBetween), DistributeColumns: icon(AlignHorizontalSpaceBetween), OptimizeTable: icon(Table2, WandSparkles),
  TableSort: icon(Table2, ArrowUpDown), ConvertTableToText: icon(Table2, FileText), ConvertTextToTable: icon(FileText, Table2),
  PageDialog: icon(FileCog), PageColumnDialog: icon(Columns2), InsertPageHeader: icon(PanelTop), InsertPageFooter: icon(PanelBottom), TitlePageDialog: icon(FilePlus2),
  InsertPagebreak: icon(PanelsTopBottom), InsertBreak: icon(ScanLine), InsertLandscapePage: icon(RectangleHorizontal),
  InsertFootnote: icon(FileText, Subscript), InsertEndnote: icon(Files, Subscript), InsertFootnoteDialog: icon(Subscript, SlidersHorizontal),
  InsertReferenceField: icon(TextQuote), InsertBookmark: icon(BookmarkPlus), InsertCaptionDialog: icon(ImagePlus, TextCursorInput),
  InsertMultiIndex: icon(TableOfContents), InsertIndexesEntry: icon(ListTree, Plus), UpdateAllIndexes: icon(ListRestart), EditCurIndex: icon(ListTree, SquarePen),
  InsertAuthoritiesEntry: icon(BookMarked, Plus), AuthoritiesEntryDialog: icon(BookMarked, SquarePen),
  SpellingAndGrammarDialog: icon(SpellCheck), ThesaurusDialog: icon(BookA), WordCountDialog: icon(TextCursorInput, Hash),
  InsertAnnotation: icon(MessageSquarePlus), ReplyComment: icon(MessageSquareReply), ResolveComment: icon(MessageSquareCheck),
  TrackChanges: icon(FilePenLine, Check), ShowTrackedChanges: icon(FilePenLine, Eye), AcceptTrackedChanges: icon(FileCheck),
  NextTrackedChange: icon(FilePenLine, ArrowDown), PreviousTrackedChange: icon(FilePenLine, ArrowUp), CompareDocuments: icon(FileDiff),
  PrintLayout: icon(FileText), BrowseView: icon(PanelsLeftRight), DraftView: icon(NotebookPen),
  ShowSinglePage: icon(File), ShowTwoPages: icon(Files), ShowMultiplePages: icon(FileStack),
  ControlCodes: icon(Pilcrow), Fieldnames: icon(Braces), ViewBounds: icon(ScanText), TableBoundaries: icon(Table2, ScanLine), PrintPagePreview: icon(FileSearch),

  AlignLeft: icon(AlignLeft), AlignHorizontalCenter: icon(AlignCenter), AlignRight: icon(AlignRight), WrapText: icon(WrapText),
  ToggleMergeCells: icon(TableCellsMerge), FormatCellDialog: icon(TableProperties), NumberFormatCurrency: icon(CircleDollarSign), NumberFormatPercent: icon(Percent),
  InsertObjectChart: icon(ChartColumnIncreasing), InsertRows: icon(TableRowsSplit, Plus), InsertColumns: icon(TableColumnsSplit, Plus),
  FunctionDialog: icon(SquareFunction), AutoSum: icon(Sigma), Calculate: icon(Calculator), CalculateHard: icon(Calculator, RefreshCw),
  DefineName: icon(Tags), AddName: icon(Tags, Plus), InsertName: icon(TextCursorInput, Tags), CreateNames: icon(Tags, WandSparkles),
  ShowPrecedents: icon(Table2, ArrowLeft), ShowDependents: icon(Table2, ArrowRight),
  ClearArrowPrecedents: icon(ArrowLeft, X), ClearArrowDependents: icon(ArrowRight, X),
  DataSort: icon(ArrowUpDown), DataFilterAutoFilter: icon(Filter), DataFilterStandardFilter: icon(Filter, List),
  DataFilterSpecialFilter: icon(Filter, SlidersHorizontal), DataFilterRemoveFilter: icon(FilterX),
  Validation: icon(ListChecks), TextToColumns: icon(Columns3, Split), DataSubTotals: icon(Table2, Calculator), DataConsolidate: icon(Merge),
  DataDataPilotRun: icon(TableProperties, Plus), RecalcPivotTable: icon(TableProperties, RefreshCw),
  Insert: icon(Sheet, Plus), RenameTable: icon(Sheet, SquarePen), Move: icon(Sheet, Move), Remove: icon(Sheet, X),
  Show: icon(Sheet, Eye), Hide: icon(Sheet, EyeOff), Protect: icon(Sheet, Lock), ToolProtectionDocument: icon(LockKeyhole),
  ColumnWidth: icon(Columns3, MoveHorizontal), RowHeight: icon(TableRowsSplit, MoveVertical),
  SetOptimalColumnWidth: icon(Columns3, WandSparkles), SetOptimalRowHeight: icon(TableRowsSplit, WandSparkles),
  NormalViewMode: icon(Grid2X2), PagebreakMode: icon(Sheet, ScanLine), ViewValueHighlighting: icon(Highlighter), ShowFormula: icon(SquareFunction, Eye),
  FreezePanes: icon(Table2, Lock), FreezePanesRow: icon(PanelTop, Lock), FreezePanesColumn: icon(Columns2, Lock),
  DefinePrintArea: icon(SquareDashed, Printer), AddPrintArea: icon(Printer, Plus), EditPrintArea: icon(Printer, SquarePen), DeletePrintArea: icon(Printer, X),
  PageFormatDialog: icon(FileSliders), PrintPreview: icon(ScanEye), PrinterSetup: icon(PrinterCheck), Print: icon(Printer),

  Text: icon(TextCursorInput), Rect: icon(RectangleHorizontal), Ellipse: icon(Circle), Line: icon(ScanLine),
  Area: icon(PaintBucket), FormatLine: icon(ScanLine, SlidersHorizontal), MasterSlidesPanel: icon(LayoutTemplate),
  MasterPage: icon(LayoutTemplate, SquarePen), SlideMasterPage: icon(Presentation, Layers), CloseMasterView: icon(PanelTopClose), MasterLayouts: icon(LayoutTemplate, Plus),
  TransformDialog: icon(Move), FormatGroup: icon(Group), FormatUngroup: icon(Ungroup),
  ObjectAlignLeft: icon(AlignStartVertical), AlignCenter: icon(AlignCenterVertical), ObjectAlignRight: icon(AlignEndVertical),
  BringToFront: icon(BringToFront), SendToBack: icon(SendToBack), Forward: icon(LayersArrowUp), Backward: icon(LayersArrowDown),
  MirrorHorz: icon(FlipHorizontal2), MirrorVert: icon(FlipVertical2),
  InsertPage: icon(Presentation, Plus), DuplicatePage: icon(Presentation, Copy), DeletePage: icon(Presentation, X),
  MovePageUp: icon(Presentation, ArrowUp), MovePageDown: icon(Presentation, ArrowDown),
  SlideChangeWindow: icon(PanelsLeftRight, Play), CustomAnimation: icon(SquarePlay), AnimationObjects: icon(SquareDashedMousePointer, Play),
  Presentation: icon(Presentation, Play), PresentationCurrentSlide: icon(CirclePlay), PresentationDialog: icon(Presentation, SlidersHorizontal), CustomShow: icon(Presentation, List),
  NotesMode: icon(MessageSquareText), NotesPage: icon(MessageSquareText), PageMode: icon(Presentation),
  NotesMasterPage: icon(MessageSquareText, Layers), MasterLayoutsNotes: icon(MessageSquareText, LayoutTemplate),
};

const formatOverrides: Partial<Record<NativeOfficeFormat, Record<string, NativeOfficeToolIcon>>> = {
  pptx: { PageDialog: icon(Presentation, SlidersHorizontal), EditStyle: icon(PaintRoller, SquarePen) },
};

export function nativeOfficeCommandIcon(format: NativeOfficeFormat, command: string): NativeOfficeToolIcon | undefined {
  const name = command.startsWith('.uno:') ? command.slice(5) : command;
  return formatOverrides[format]?.[name] ?? commands[name];
}

export const nativeOfficeStyleIcons: Record<string, NativeOfficeToolIcon> = {
  bold: icon(Bold), italic: icon(Italic), underline: icon(Underline), strike: icon(Strikethrough), wrap: icon(WrapText),
};
