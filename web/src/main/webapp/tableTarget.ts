/*
 * Copyright (c) 2017 VMware Inc. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This file contains lots of methods for accessing the remote TableTarget.java class.
 */

import {DatasetView, IViewSerialization} from "./datasetView";
import {
    CombineOperators,
    JSCreateColumnInfo,
    DataRange,
    FilterDescription,
    Heatmap,
    HistogramArgs,
    HistogramBase,
    HLogLog,
    IColumnDescription,
    kindIsString,
    NextKList,
    RangeArgs,
    RecordOrder,
    RemoteObjectId,
    Schema,
    TableSummary,
    TopList,
    NextKArgs,
    ComparisonFilterDescription,
    EigenVal,
    StringRowFilterDescription,
    FindResult,
    Heatmap3D,
    StringFilterDescription,
    ContainsArgs, KVCreateColumnInfo,
} from "./javaBridge";
import {OnCompleteReceiver, RemoteObject, RpcRequest} from "./rpc";
import {FullPage, PageTitle} from "./ui/fullPage";
import {PointSet, Resolution, ViewKind} from "./ui/ui";
import {assert, ICancellable, Pair, PartialResult, Seed} from "./util";
import {IDataView} from "./ui/dataview";
import {SchemaClass} from "./schemaClass";
import {PlottingSurface} from "./ui/plottingSurface";

/**
 * An interface which has a function that is called when all updates are completed.
 */
export interface CompletedWithTime {
    updateCompleted(timeInMs: number): void;
}

export interface OnNextK extends CompletedWithTime {
    updateView(nextKList: NextKList,
               revert: boolean,
               order: RecordOrder,
               result: FindResult): void;
}

/**
 * This class has methods that correspond directly to TableTarget.java methods.
 */
export class TableTargetAPI extends RemoteObject {
    /**
     * Create a reference to a remote table target.
     * @param remoteObjectId   Id of remote table on the web server.
     */
    constructor(public readonly remoteObjectId: RemoteObjectId) {
        super(remoteObjectId);
    }

    public createZipRequest(r: RemoteObject): RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("zip", r.remoteObjectId);
    }

    public createFindRequest(
        order: RecordOrder, topRow: any[],
        strFilter: StringFilterDescription, excludeTopRow: boolean, next: boolean):
        RpcRequest<PartialResult<FindResult>> {
        return this.createStreamingRpcRequest<FindResult>("find", {
            order: order,
            topRow: topRow,
            stringFilterDescription: strFilter,
            excludeTopRow: excludeTopRow,
            next: next,
        });
    }

    public createQuantileRequest(rowCount: number, o: RecordOrder, position: number):
            RpcRequest<PartialResult<any[]>> {
        return this.createStreamingRpcRequest<any[]>("quantile", {
            precision: 100,
            tableSize: rowCount,
            order: o,
            position: position,
            seed: Seed.instance.get(),
        });
    }

    /**
     * Computes the maximum resolution at which a data range request must be made.
     * @param page      Page - used to compute the screen size.
     * @param viewKind  Desired view for the data.
     */
    private static rangesResolution(page: FullPage, viewKind: ViewKind): number[] {
        const width = page.getWidthInPixels();
        const size = PlottingSurface.getDefaultCanvasSize(width);
        const maxWindows = Math.floor(width / Resolution.minTrellisWindowSize) *
            Math.floor(size.height / Resolution.minTrellisWindowSize);
        switch (viewKind) {
            case "Histogram":
                // Always get the window size; we integrate the CDF to draw the actual histogram.
                return [size.width];
            case "2DHistogram":
                // On the horizontal axis we get the maximum resolution, which we will use for
                // deriving the CDF curve.  On the vertical axis we use a smaller number.
                return [width, Resolution.maxBucketCount];
            case "Heatmap":
                return [Math.floor(size.width / Resolution.minDotSize),
                        Math.floor(size.height / Resolution.minDotSize)];
            case "Trellis2DHistogram":
            case "TrellisHeatmap":
                return [width, Resolution.maxBucketCount, maxWindows];
            case "TrellisHistogram":
                return [width, maxWindows];
            default:
                assert(false, "Unhandled case " + viewKind);
                return null;
        }
    }

    public createDataRangesRequest(cds: IColumnDescription[], page: FullPage, viewKind: ViewKind):
        RpcRequest<PartialResult<DataRange[]>> {

        // Determine the resolution of the ranges request based on the plot kind.
        const buckets: number[] = TableTargetAPI.rangesResolution(page, viewKind);
        assert(buckets.length === cds.length);
        const args: RangeArgs[] = [];
        for (let i = 0; i < cds.length; i++) {
            const cd = cds[i];
            const seed = kindIsString(cd.kind) ? Seed.instance.get() : 0;
            const arg: RangeArgs = {
                cd: cd,
                seed: seed,
                stringsToSample: buckets[i]
            };
            args.push(arg);
        }
        const method = "getDataRanges" + cds.length + "D";
        return this.createStreamingRpcRequest<DataRange>(method, args);
    }

    public createContainsRequest(order: RecordOrder, row: any[]): RpcRequest<RemoteObjectId> {
        const args: ContainsArgs = {
            order: order,
            row: row
        };
        return this.createStreamingRpcRequest<RemoteObjectId>("contains", args);
    }

    public createGetLogFragmentRequest(schema: Schema, row: any[], rowSchema: Schema, rowCount: number):
        RpcRequest<PartialResult<NextKList>> {
        return this.createStreamingRpcRequest<NextKList>("getLogFragment", {
            schema: schema,
            row: row,
            rowSchema: rowSchema,
            count: rowCount
        });
    }

    /**
     * Create a request for a nextK sketch
     * @param order            Sorting order.
     * @param firstRow         Values in the smallest row (may be null).
     * @param rowsOnScreen     How many rows to bring.
     * @param columnsNoValue   List of columns in the firstRow for which we want to specify "minimum possible value"
     * instead of "null".
     */
    public createNextKRequest(order: RecordOrder, firstRow: any[] | null, rowsOnScreen: number,
                              columnsNoValue?: string[]):
        RpcRequest<PartialResult<NextKList>> {
        const nextKArgs: NextKArgs = {
            toFind: null,
            order: order,
            firstRow: firstRow,
            rowsOnScreen: rowsOnScreen,
            columnsNoValue: columnsNoValue
        };
        return this.createStreamingRpcRequest<NextKList>("getNextK", nextKArgs);
    }

    public createGetSchemaRequest(): RpcRequest<PartialResult<TableSummary>> {
        return this.createStreamingRpcRequest<TableSummary>("getSchema", null);
    }

    public createHLogLogRequest(colName: string): RpcRequest<PartialResult<HLogLog>> {
        return this.createStreamingRpcRequest<HLogLog>("hLogLog",
            { columnName: colName, seed: Seed.instance.get() });
    }

    public createHeavyHittersRequest(columns: IColumnDescription[],
                                     percent: number,
                                     totalRows: number,
                                     threshold: number): RpcRequest<PartialResult<TopList>> {
        if (percent < threshold) {
            return this.createStreamingRpcRequest<TopList>("heavyHittersMG",
                {columns: columns, amount: percent,
                    totalRows: totalRows, seed: Seed.instance.get() });
        } else {
            return this.createStreamingRpcRequest<TopList>("heavyHittersSampling",
                {columns: columns, amount: percent,
                    totalRows: totalRows, seed: Seed.instance.get() });
        }
    }

    public createCheckHeavyRequest(r: RemoteObject, schema: Schema):
            RpcRequest<PartialResult<TopList>> {
        return this.createStreamingRpcRequest<TopList>("checkHeavy", {
            hittersId: r.remoteObjectId,
            schema: schema
        });
    }

    public createFilterHeavyRequest(rid: RemoteObjectId, schema: Schema, includeSet: boolean):
        RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("filterHeavy", {
            hittersId: rid,
            schema: schema,
            includeSet: includeSet
        });
    }

    public createFilterListHeavy(rid: RemoteObjectId, schema: Schema, includeSet: boolean, rowIndices: number[]):
        RpcRequest<PartialResult<RemoteObjectId>> {
            return this.createStreamingRpcRequest<RemoteObjectId>("filterListHeavy", {
                hittersId: rid,
                schema: schema,
                includeSet: includeSet,
                rowIndices: rowIndices
            });
    }

    public createProjectToEigenVectorsRequest(r: RemoteObject, dimension: number, projectionName: string):
    RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("projectToEigenVectors", {
            id: r.remoteObjectId,
            numComponents: dimension,
            projectionName: projectionName
        });
    }

    public createFilterEqualityRequest(filter: StringRowFilterDescription):
            RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("filterEquality", filter);
    }

    public createFilterComparisonRequest(filter: ComparisonFilterDescription):
    RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("filterComparison", filter);
    }

    public createCorrelationMatrixRequest(columnNames: string[], totalRows: number, toSample: boolean):
RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("correlationMatrix", {
            columnNames: columnNames,
            totalRows: totalRows,
            seed: Seed.instance.get(),
            toSample: toSample
        });
    }

    public createProjectRequest(schema: Schema): RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("project", schema);
    }

    public createSpectrumRequest(columnNames: string[], totalRows: number, toSample: boolean):
    RpcRequest<PartialResult<EigenVal>> {
        return this.createStreamingRpcRequest<EigenVal>("spectrum", {
            columnNames: columnNames,
            totalRows: totalRows,
            seed: Seed.instance.get(),
            toSample: toSample
        });
    }

    public createJSCreateColumnRequest(c: JSCreateColumnInfo):
        RpcRequest<PartialResult<string>> {
        return this.createStreamingRpcRequest<string>("jsCreateColumn", c);
    }

    public createKVCreateColumnRequest(c: KVCreateColumnInfo):
        RpcRequest<PartialResult<string>> {
        return this.createStreamingRpcRequest<string>("kvCreateColumn", c);
    }

    public createFilterRequest(f: FilterDescription):
        RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("filterRange", f);
    }

    public createFilter2DRequest(xRange: FilterDescription, yRange: FilterDescription):
            RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("filter2DRange",
            {first: xRange, second: yRange});
    }

    public createHistogram2DRequest(info: HistogramArgs[]):
        RpcRequest<PartialResult<Pair<Heatmap, HistogramBase>>> {
        return this.createStreamingRpcRequest<Pair<Heatmap, HistogramBase>>("histogram2D", info);
    }

    public createHeatmapRequest(info: HistogramArgs[]): RpcRequest<PartialResult<Heatmap>> {
        return this.createStreamingRpcRequest<Heatmap>("heatmap", info);
    }

    public createTrellis2DHistogramRequest(info: HistogramArgs[]): RpcRequest<PartialResult<Heatmap3D>> {
        return this.createStreamingRpcRequest<Heatmap>("heatmap3D", info);
    }

    public createHeatmap3DRequest(info: HistogramArgs[]): RpcRequest<PartialResult<Heatmap3D>> {
        return this.createStreamingRpcRequest<Heatmap3D>("heatmap3D", info);
    }

    public createHistogramRequest(info: HistogramArgs):
        RpcRequest<PartialResult<HistogramBase>> {
        return this.createStreamingRpcRequest<HistogramBase>(
            "histogram", info);
    }

    public createSetOperationRequest(setOp: CombineOperators): RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("setOperation", CombineOperators[setOp]);
    }

    public createSampledControlPointsRequest(rowCount: number, numSamples: number, columnNames: string[]):
            RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("sampledControlPoints",
            {rowCount: rowCount, numSamples: numSamples, columnNames: columnNames, seed: Seed.instance.get() });
    }

    public createCategoricalCentroidsControlPointsRequest(
        categoricalColumnName: string, numericalColumnNames: string[]):
            RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("categoricalCentroidsControlPoints", {
                categoricalColumnName: categoricalColumnName,
                numericalColumnNames: numericalColumnNames} );
    }

    public createMDSProjectionRequest(id: RemoteObjectId): RpcRequest<PartialResult<PointSet>> {
        return this.createStreamingRpcRequest<PointSet>(
            "makeMDSProjection", { id: id, seed: Seed.instance.get() });
    }

    public createLAMPMapRequest(controlPointsId: RemoteObjectId,
                                colNames: string[], controlPoints: PointSet, newColNames: string[]):
            RpcRequest<PartialResult<RemoteObjectId>> {
        return this.createStreamingRpcRequest<RemoteObjectId>("lampMap",
            {controlPointsId: controlPointsId, colNames: colNames,
                newLowDimControlPoints: controlPoints, newColNames: newColNames});
    }
}

/**
 * This is an IDataView that is also a TableTargetAPI.
 * "Big" tables are table-shaped remote datasets, represented
 * in Java by IDataSet<ITable>.
 * This is a base class for most views that are rendering
 * information from a big table.
 * A BigTableView view is always part of a DatasetView.
 */
export abstract class BigTableView extends TableTargetAPI implements IDataView, CompletedWithTime {
    protected topLevel: HTMLElement;
    public readonly dataset: DatasetView;

    /**
     * Create a view for a big table.
     * @param remoteObjectId   Id of remote table on the web server.
     * @param schema           Schema of the current view (usually a subset of the schema of the
     *                         big table).
     * @param rowCount         Total number of rows in the big table.
     * @param page             Page where the view is displayed.
     * @param viewKind         Kind of view displayed.
     */
    protected constructor(
        remoteObjectId: RemoteObjectId,
        public rowCount: number,
        public schema: SchemaClass,
        public page: FullPage,
        public readonly viewKind: ViewKind) {
        super(remoteObjectId);
        this.setPage(page);
        this.dataset = page.dataset;
    }

    /**
     * Save the information needed to (re)create this view.
     */
    public serialize(): IViewSerialization {
        return {
            viewKind: this.viewKind,
            pageId: this.page.pageId,
            sourcePageId: this.page.sourcePageId,
            title: this.page.title.format,
            remoteObjectId: this.remoteObjectId,
            rowCount: this.rowCount,
            schema: this.schema.serialize(),
        };
    }

    public setPage(page: FullPage): void {
        if (page == null)
            throw new Error(("null FullPage"));
        this.page = page;
        if (this.topLevel != null) {
            this.topLevel.ondragover = (e) => e.preventDefault();
            this.topLevel.ondrop = (e) => this.drop(e);
        }
    }

    // noinspection JSMethodCanBeStatic
    public drop(e: DragEvent): void { console.log(e); }

    public getPage(): FullPage {
        if (this.page == null)
            throw new Error(("Page not set"));
        return this.page;
    }

    public selectCurrent(): void {
        this.dataset.select(this, this.page.pageId);
    }

    public abstract resize(): void;
    public abstract refresh(): void;

    public getHTMLRepresentation(): HTMLElement {
        return this.topLevel;
    }

    /**
     * This method is called by the zip receiver after combining two datasets.
     * It should return a renderer which will handle the newly received object
     * after the zip has been performed.
     */
    protected abstract getCombineRenderer(title: PageTitle):
        (page: FullPage, operation: ICancellable<RemoteObjectId>) => BaseRenderer;

    public combine(how: CombineOperators): void {
        const r = this.dataset.getSelected();
        if (r.first == null) {
            this.page.reportError("No original dataset selected");
            return;
        }

        const rr = this.createZipRequest(r.first);
        const renderer = this.getCombineRenderer(
            new PageTitle("%p(" + r.second + ")" + CombineOperators[how]));
        rr.invoke(new ZipReceiver(this.getPage(), rr, how, this.dataset, renderer));
    }

    /**
     * This method is called when all the data has been received.
     */
    public updateCompleted(timeInMs: number): void {
        this.page.reportTime(timeInMs);
    }
}

/**
 * A renderer that receives a remoteObjectId for a big table.
 */
export abstract class BaseRenderer extends OnCompleteReceiver<RemoteObjectId> {
    protected remoteObject: TableTargetAPI;

    protected constructor(public page: FullPage,
                          public operation: ICancellable<RemoteObjectId>,
                          public description: string,
                          protected dataset: DatasetView) { // may be null for the first table
        super(page, operation, description);
        this.remoteObject = null;
    }

    public run(): void {
        if (this.value != null)
            this.remoteObject = new TableTargetAPI(this.value);
    }
}

/**
 * A zip receiver receives the result of a Zip operation on
 * two IDataSet<ITable> objects (an IDataSet<Pair<ITable, ITable>>,
 *  and applies to the pair the specified set operation setOp.
 */
class ZipReceiver extends BaseRenderer {
    public constructor(page: FullPage,
                       operation: ICancellable<RemoteObjectId>,
                       protected setOp: CombineOperators,
                       protected dataset: DatasetView,
                       // receiver constructs the renderer that is used to display
                       // the result after combining
                       protected receiver:
                           (page: FullPage, operation: ICancellable<RemoteObjectId>) => BaseRenderer) {
        super(page, operation, "zip", dataset);
    }

    public run(): void {
        super.run();
        const rr = this.remoteObject.createSetOperationRequest(this.setOp);
        const rec = this.receiver(this.page, rr);
        rr.invoke(rec);
    }
}
