<?php



Route::group([
    'prefix' => config('backpack.base.route_prefix', 'admin'),
    'middleware' => ['admin'],

], function() {

    CRUD::resource('case', 'CaseCrudController');
    CRUD::resource('equipment', 'EquipmentCrudController');
});
?>
